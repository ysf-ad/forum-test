'use strict';

const db = require('../database');
const posts = require('../posts');
const privileges = require('../privileges');
const plugins = require('../plugins');
const meta = require('../meta');
const topics = require('../topics');
const user = require('../user');
const notifications = require('../notifications');
const socketHelpers = require('./helpers');
const utils = require('../utils');
const api = require('../api');
const apiHelpers = require('../api/helpers');

const sockets = require('.');

const SocketPosts = module.exports;

require('./posts/edit')(SocketPosts);
require('./posts/move')(SocketPosts);
require('./posts/votes')(SocketPosts);
require('./posts/bookmarks')(SocketPosts);
require('./posts/tools')(SocketPosts);
require('./posts/diffs')(SocketPosts);

SocketPosts.reply = async function (socket, data) {
	sockets.warnDeprecated(socket, 'POST /api/v3/topics/:tid');

	if (!data || !data.tid || (meta.config.minimumPostLength !== 0 && !data.content)) {
		throw new Error('[[error:invalid-data]]');
	}

	apiHelpers.setDefaultPostData(socket, data);
	await meta.blacklist.test(data.req.ip);
	const shouldQueue = await posts.shouldQueue(socket.uid, data);
	if (shouldQueue) {
		return await posts.addToQueue(data);
	}
	return await postReply(socket, data);
};

async function postReply(socket, data) {
	const postData = await topics.reply(data);
	const result = {
		posts: [postData],
		'reputation:disabled': meta.config['reputation:disabled'] === 1,
		'downvote:disabled': meta.config['downvote:disabled'] === 1,
	};

	if (socket.emit) {
		socket.emit('event:new_post', result);
	}
	user.updateOnlineUsers(socket.uid);

	socketHelpers.notifyNew(socket.uid, 'newPost', result);

	return postData;
}

SocketPosts.getRawPost = async function (socket, pid) {
	const canRead = await privileges.posts.can('topics:read', pid, socket.uid);
	if (!canRead) {
		throw new Error('[[error:no-privileges]]');
	}

	const postData = await posts.getPostFields(pid, ['content', 'deleted']);
	if (postData.deleted) {
		throw new Error('[[error:no-post]]');
	}
	postData.pid = pid;
	const result = await plugins.hooks.fire('filter:post.getRawPost', { uid: socket.uid, postData: postData });
	return result.postData.content;
};

SocketPosts.getPostSummaryByIndex = async function (socket, data) {
	if (data.index < 0) {
		data.index = 0;
	}
	let pid;
	if (data.index === 0) {
		pid = await topics.getTopicField(data.tid, 'mainPid');
	} else {
		pid = await db.getSortedSetRange(`tid:${data.tid}:posts`, data.index - 1, data.index - 1);
	}
	pid = Array.isArray(pid) ? pid[0] : pid;
	if (!pid) {
		return 0;
	}

	const topicPrivileges = await privileges.topics.get(data.tid, socket.uid);
	if (!topicPrivileges['topics:read']) {
		throw new Error('[[error:no-privileges]]');
	}

	const postsData = await posts.getPostSummaryByPids([pid], socket.uid, { stripTags: false });
	posts.modifyPostByPrivilege(postsData[0], topicPrivileges);
	return postsData[0];
};

SocketPosts.getPostSummaryByPid = async function (socket, data) {
	if (!data || !data.pid) {
		throw new Error('[[error:invalid-data]]');
	}
	const { pid } = data;
	const tid = await posts.getPostField(pid, 'tid');
	const topicPrivileges = await privileges.topics.get(tid, socket.uid);
	if (!topicPrivileges['topics:read']) {
		throw new Error('[[error:no-privileges]]');
	}

	const postsData = await posts.getPostSummaryByPids([pid], socket.uid, { stripTags: false });
	posts.modifyPostByPrivilege(postsData[0], topicPrivileges);
	return postsData[0];
};

SocketPosts.getPost = async function (socket, pid) {
	sockets.warnDeprecated(socket, 'GET /api/v3/posts/:pid');
	return await api.posts.get(socket, { pid });
};

SocketPosts.getCategory = async function (socket, pid) {
	return await posts.getCidByPid(pid);
};

SocketPosts.getPidIndex = async function (socket, data) {
	if (!data) {
		throw new Error('[[error:invalid-data]]');
	}
	return await posts.getPidIndex(data.pid, data.tid, data.topicPostSort);
};

SocketPosts.getReplies = async function (socket, pid) {
	if (!utils.isNumber(pid)) {
		throw new Error('[[error:invalid-data]]');
	}
	const { topicPostSort } = await user.getSettings(socket.uid);
	const pids = await posts.getPidsFromSet(`pid:${pid}:replies`, 0, -1, topicPostSort === 'newest_to_oldest');

	let [postData, postPrivileges] = await Promise.all([
		posts.getPostsByPids(pids, socket.uid),
		privileges.posts.get(pids, socket.uid),
	]);
	postData = await topics.addPostData(postData, socket.uid);
	postData.forEach((postData, index) => posts.modifyPostByPrivilege(postData, postPrivileges[index]));
	postData = postData.filter((postData, index) => postData && postPrivileges[index].read);
	return postData;
};

SocketPosts.accept = async function (socket, data) {
	const result = await acceptOrReject(posts.submitFromQueue, socket, data);
	await sendQueueNotification('post-queue-accepted', result.uid, `/post/${result.pid}`);
};

SocketPosts.reject = async function (socket, data) {
	const result = await acceptOrReject(posts.removeFromQueue, socket, data);
	await sendQueueNotification('post-queue-rejected', result.uid, '/');
};

async function acceptOrReject(method, socket, data) {
	const canEditQueue = await posts.canEditQueue(socket.uid, data);
	if (!canEditQueue) {
		throw new Error('[[error:no-privileges]]');
	}
	return await method(data.id);
}

async function sendQueueNotification(type, targetUid, path) {
	const notifData = {
		type: type,
		nid: `${type}-${targetUid}-${path}`,
		bodyShort: type === 'post-queue-accepted' ?
			'[[notifications:post-queue-accepted]]' : '[[notifications:post-queue-rejected]]',
		path: path,
	};
	if (parseInt(meta.config.postQueueNotificationUid, 10) > 0) {
		notifData.from = meta.config.postQueueNotificationUid;
	}
	const notifObj = await notifications.create(notifData);
	await notifications.push(notifObj, [targetUid]);
}

SocketPosts.editQueuedContent = async function (socket, data) {
	if (!data || !data.id || (!data.content && !data.title && !data.cid)) {
		throw new Error('[[error:invalid-data]]');
	}
	await posts.editQueuedContent(socket.uid, data);
	if (data.content) {
		return await plugins.hooks.fire('filter:parse.post', { postData: data });
	}
	return { postData: data };
};

require('../promisify')(SocketPosts);
