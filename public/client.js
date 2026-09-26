const socket = io({ autoConnect: false });
let currentUser = null;
let selectedContact = null;
let activeRoomId = null;
let chatSelectionToken = 0;
let isRegisterMode = false;
const chatArea = document.getElementById('chatArea');
const messageForm = document.getElementById('messageForm');
const messageInput = document.getElementById('messageInput');
const callModal = document.getElementById('callModal');
const callTitle = document.getElementById('callTitle');
const callStatus = document.getElementById('callStatus');
const voiceStatus = document.getElementById('voiceStatus');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo = document.getElementById('localVideo');
const voicePlaceholder = document.getElementById('voicePlaceholder');
const toast = document.getElementById('toast');
const deleteConfirmModal = document.getElementById('deleteConfirmModal');
const confirmDeleteButton = document.getElementById('confirmDeleteButton');
const cancelDeleteButton = document.getElementById('cancelDeleteButton');
const authScreen = document.getElementById('authScreen');
const authForm = document.getElementById('authForm');
const authTitle = document.getElementById('authTitle');
const authSubtitle = document.getElementById('authSubtitle');
const authUsername = document.getElementById('authUsername');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authConfirmPassword = document.getElementById('authConfirmPassword');
const emailField = document.getElementById('emailField');
const confirmPasswordField = document.getElementById('confirmPasswordField');
const authSubmit = document.getElementById('authSubmit');
const authSwitch = document.getElementById('authSwitch');
const authError = document.getElementById('authError');
const profileButton = document.getElementById('profileButton');
const profileMenu = document.getElementById('profileMenu');
const settingsModal = document.getElementById('settingsModal');
const contactsModal = document.getElementById('contactsModal');
const homeButton = document.getElementById('homeButton');
const acceptCallButton = document.getElementById('acceptCallButton');
const rejectCallButton = document.getElementById('rejectCallButton');
const soundToggle = document.querySelector('.settings-row input[type="checkbox"]:not(#activeStatusToggle)');
const doNotDisturbToggle = document.querySelectorAll('.settings-row input[type="checkbox"]')[2];

function loadPreferences() {
  const preferences = JSON.parse(localStorage.getItem('direct-preferences') || '{}');
  document.body.classList.toggle('dark-theme', preferences.theme === 'dark');
  const themeInput = document.querySelector(`input[name="theme"][value="${preferences.theme || 'light'}"]`);
  if (themeInput) themeInput.checked = true;
  if (soundToggle) soundToggle.checked = preferences.sound !== false;
  if (doNotDisturbToggle) doNotDisturbToggle.checked = preferences.doNotDisturb === true;
}

function savePreferences() {
  const theme = document.querySelector('input[name="theme"]:checked')?.value || 'light';
  localStorage.setItem('direct-preferences', JSON.stringify({
    theme,
    sound: soundToggle?.checked !== false,
    doNotDisturb: doNotDisturbToggle?.checked === true
  }));
}

document.querySelectorAll('[data-mobile-nav]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.mobile-nav-button').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  const destination = button.dataset.mobileNav;
  if (destination === 'contacts') openContacts();
  if (destination === 'profile') profileButton.click();
  if (destination === 'messages') {
    document.getElementById('appShell').classList.remove('mobile-chat-open');
    document.getElementById('messagesTab').click();
  }
  if (destination === 'search') {
    document.getElementById('appShell').classList.remove('mobile-chat-open');
    setTimeout(() => document.querySelector('.search-box input').focus(), 0);
  }
}));
document.addEventListener('click', (event) => {
  if (!event.target.closest('.message-tools')) document.querySelectorAll('.message-tools.open, .message-tools.visible').forEach((item) => item.classList.remove('open', 'visible'));
});
cancelDeleteButton.addEventListener('click', closeDeleteConfirm);
deleteConfirmModal.addEventListener('click', (event) => { if (event.target === deleteConfirmModal) closeDeleteConfirm(); });
confirmDeleteButton.addEventListener('click', () => {
  if (pendingDeleteMessageId && socket.connected) socket.emit('delete-message', { messageId: pendingDeleteMessageId });
  closeDeleteConfirm();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && deleteConfirmModal.classList.contains('visible')) closeDeleteConfirm();
});

let peerConnection = null;
let localStream = null;
let screenStream = null;
let pendingIceCandidates = [];
let activePeerId = null;
let activeCallMode = 'video';
let isCaller = false;
let pendingIncomingCall = null;
let reconnectAttempts = 0;
let toastTimer = null;
let rtcConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let typingTimer = null;
let replyToMessageId = null;
let oldestMessageTimestamp = null;
let searchRequestId = 0;
let pendingDeleteMessageId = null;

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  try {
    const payload = { username: authUsername.value, password: authPassword.value };
    if (isRegisterMode) {
      payload.email = authEmail.value;
      payload.confirmPassword = authConfirmPassword.value;
    }
    const response = await fetch(`/api/auth/${isRegisterMode ? 'register' : 'login'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Authentication failed');
    enterApp(result.user);
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
});

authSwitch.addEventListener('click', () => {
  isRegisterMode = !isRegisterMode;
  authTitle.textContent = isRegisterMode ? 'Create your account' : 'Welcome';
  authSubtitle.textContent = isRegisterMode ? 'Register to start messaging.' : 'Sign in to continue to your messages.';
  authSubmit.textContent = isRegisterMode ? 'Create account' : 'Sign in';
  authSwitch.textContent = isRegisterMode ? 'Already have an account? Sign in' : 'Create an account';
  emailField.hidden = !isRegisterMode;
  confirmPasswordField.hidden = !isRegisterMode;
  authEmail.required = isRegisterMode;
  authConfirmPassword.required = isRegisterMode;
  authPassword.autocomplete = isRegisterMode ? 'new-password' : 'current-password';
  authError.textContent = '';
});

profileButton.addEventListener('click', () => {
  const isOpen = profileMenu.classList.toggle('visible');
  profileMenu.setAttribute('aria-hidden', String(!isOpen));
});

document.getElementById('settingsButton').addEventListener('click', () => {
  profileMenu.classList.remove('visible');
  profileMenu.setAttribute('aria-hidden', 'true');
  settingsModal.classList.add('visible');
  settingsModal.setAttribute('aria-hidden', 'false');
});

document.getElementById('settingsClose').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (event) => { if (event.target === settingsModal) closeSettings(); });
document.getElementById('activeStatusToggle').addEventListener('change', (event) => {
  document.getElementById('activeStatusLabel').textContent = event.target.checked ? 'เปิด' : 'ปิด';
});
document.querySelectorAll('input[name="theme"]').forEach((input) => input.addEventListener('change', (event) => {
  document.body.classList.toggle('dark-theme', event.target.value === 'dark');
  savePreferences();
}));
soundToggle?.addEventListener('change', savePreferences);
doNotDisturbToggle?.addEventListener('change', savePreferences);

document.getElementById('menuLogoutButton').addEventListener('click', logout);
document.getElementById('editProfileButton').addEventListener('click', async () => {
  const username = window.prompt('Username', currentUser?.username || '');
  if (!username) return;
  const email = window.prompt('Email', currentUser?.email || '');
  if (!email) return;
  const response = await fetch('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, email }) });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'แก้ไขโปรไฟล์ไม่สำเร็จ');
  enterApp(result.user);
  showToast('อัปเดตโปรไฟล์แล้ว');
});
document.getElementById('contactsButton').addEventListener('click', openContacts);
document.getElementById('contactsClose').addEventListener('click', closeContacts);
contactsModal.addEventListener('click', (event) => { if (event.target === contactsModal) closeContacts(); });
homeButton.addEventListener('click', goToHome);
document.getElementById('mobileBackButton').addEventListener('click', () => {
  document.getElementById('appShell').classList.remove('mobile-chat-open');
});
document.getElementById('messagesTab').addEventListener('click', () => setMessageTab('messages'));
document.getElementById('desktopComposeButton').addEventListener('click', openContacts);
document.querySelector('.mobile-compose').addEventListener('click', openContacts);
document.getElementById('railSettingsButton').addEventListener('click', () => document.getElementById('settingsButton').click());
document.getElementById('attachButton').addEventListener('click', () => {
  if (!selectedContact) return showToast('เลือกเพื่อนก่อนแนบไฟล์');
  document.getElementById('attachmentInput').click();
});
document.getElementById('attachmentInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file || !selectedContact || !socket.connected) return;
  uploadAttachment(file).finally(() => { event.target.value = ''; });
});
document.getElementById('requestsButton').addEventListener('click', async () => {
  setMessageTab('requests');
  await openContacts();
  document.getElementById('friendRequestsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelector('.search-box input').addEventListener('input', async (event) => {
  const query = event.target.value.trim().toLowerCase();
  if (query.length >= 2) {
    const requestId = ++searchRequestId;
    const response = await fetch(`/api/messages/search?q=${encodeURIComponent(query)}`);
    if (requestId !== searchRequestId || !response.ok) return;
    renderSearchResults((await response.json()).messages);
    return;
  }
  loadConversations();
});

function closeSettings() {
  settingsModal.classList.remove('visible');
  settingsModal.setAttribute('aria-hidden', 'true');
}

async function openContacts() {
  contactsModal.classList.add('visible');
  contactsModal.setAttribute('aria-hidden', 'false');
  try {
    const response = await fetch('/api/contacts');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    renderPeople('friendsList', result.friends, false);
    renderPeople('suggestionsList', result.suggestions, true);
    renderFriendNotes(result.friends);
    renderInboxNotes(result.friends);
    renderFriendRequests(result.requests);
    await loadBlockedUsers();
    setContactBadge(result.requestCount);
  } catch (_error) {
    document.getElementById('friendsList').innerHTML = '<p class="empty-contacts">โหลดรายชื่อไม่สำเร็จ</p>';
  }
}

async function loadBlockedUsers() {
  const container = document.getElementById('blockedList');
  const response = await fetch('/api/blocked');
  if (!response.ok) return;
  const { blocked } = await response.json();
  container.innerHTML = blocked.length ? blocked.map((person) => `<div class="person-row"><span class="person-avatar">${person.username.slice(0, 2).toUpperCase()}</span><span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>ผู้ใช้ที่ถูกบล็อก</small></span><button class="request-action accept" data-unblock-id="${person.id}">เลิกบล็อก</button></div>`).join('') : '<p class="empty-contacts">ยังไม่มีผู้ใช้ที่บล็อก</p>';
  container.querySelectorAll('[data-unblock-id]').forEach((button) => button.addEventListener('click', async () => {
    const unblockResponse = await fetch(`/api/contacts/${button.dataset.unblockId}/block`, { method: 'DELETE' });
    if (unblockResponse.ok) { showToast('เลิกบล็อกแล้ว'); openContacts(); }
  }));
}

async function refreshFriendRequestBadge() {
  try {
    const response = await fetch('/api/contacts');
    if (response.ok) setContactBadge((await response.json()).requestCount);
  } catch (_error) {
    // The contacts screen will show the full error state when opened.
  }
}

function setContactBadge(count) {
  const badge = document.getElementById('contactBadge');
  const tabBadge = document.getElementById('requestsTabBadge');
  badge.textContent = count;
  badge.hidden = !count;
  tabBadge.textContent = count;
  tabBadge.hidden = !count;
  const mobileBadge = document.getElementById('mobileNavBadge');
  mobileBadge.textContent = count;
  mobileBadge.hidden = !count;
}

function setMessageTab(tab) {
  document.getElementById('messagesTab').classList.toggle('active', tab === 'messages');
  document.getElementById('requestsButton').classList.toggle('active', tab === 'requests');
}

function goToHome() {
  chatSelectionToken += 1;
  selectedContact = null;
  activeRoomId = null;
  closeContacts();
  closeSettings();
  profileMenu.classList.remove('visible');
  profileMenu.setAttribute('aria-hidden', 'true');
  setMessageTab('messages');
  document.querySelectorAll('.mobile-nav-button').forEach((item) => item.classList.toggle('active', item.dataset.mobileNav === 'messages'));
  document.getElementById('appShell').classList.remove('mobile-chat-open');
  document.getElementById('chatAvatar').textContent = '?';
  document.getElementById('chatContactName').textContent = 'เลือกเพื่อน';
  document.getElementById('chatContactStatus').textContent = 'พร้อมเริ่มการสนทนา';
  chatArea.innerHTML = '<div class="date-divider"><span>วันนี้</span></div><div class="welcome-card"><div class="welcome-orb"><i class="fa-solid fa-bolt"></i></div><h3>Start the conversation</h3><p>Messages travel over a persistent TCP connection powered by Socket.io.</p></div>';
}

function closeContacts() {
  contactsModal.classList.remove('visible');
  contactsModal.setAttribute('aria-hidden', 'true');
}

function renderPeople(elementId, people, showAddButton) {
  const container = document.getElementById(elementId);
  if (!people.length) {
    container.innerHTML = `<p class="empty-contacts">${showAddButton ? 'ยังไม่มีรายชื่อแนะนำ' : 'ยังไม่มีเพื่อน'}</p>`;
    return;
  }
  container.innerHTML = people.map((person) => {
    const initials = person.username.slice(0, 2).toUpperCase();
    if (showAddButton) return `<button class="person-row" data-user-id="${person.id}"><span class="person-avatar">${initials}</span><span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>แนะนำสำหรับคุณ</small></span><span class="add-person">เพิ่ม</span></button>`;
    return `<div class="person-row" data-user-id="${person.id}"><span class="person-avatar">${initials}</span><span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>เพื่อนของคุณ</small></span><button class="contact-action remove" data-action="remove" title="ลบเพื่อน" aria-label="ลบเพื่อน"><i class="fa-solid fa-user-minus"></i></button><button class="contact-action block" data-action="block" title="บล็อกผู้ใช้" aria-label="บล็อกผู้ใช้"><i class="fa-solid fa-ban"></i></button></div>`;
  }).join('');
  container.querySelectorAll('.person-row').forEach((row) => {
    row.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'remove') return updateContact(row.dataset.userId, 'remove');
      if (action === 'block') return updateContact(row.dataset.userId, 'block');
      if (showAddButton) addFriend(row.dataset.userId);
      else selectContact(people.find((person) => person.id === row.dataset.userId));
    });
  });
}

async function updateContact(friendId, action) {
  const confirmed = window.confirm(action === 'block' ? 'บล็อกผู้ใช้นี้ใช่ไหม' : 'ลบเพื่อนคนนี้ใช่ไหม');
  if (!confirmed) return;
  const response = await fetch(`/api/contacts/${friendId}${action === 'block' ? '/block' : ''}`, { method: action === 'block' ? 'POST' : 'DELETE' });
  if (!response.ok) return showToast('ดำเนินการไม่สำเร็จ');
  if (selectedContact?.id === friendId) {
    selectedContact = null;
    document.getElementById('appShell').classList.remove('mobile-chat-open');
  }
  showToast(action === 'block' ? 'บล็อกผู้ใช้แล้ว' : 'ลบเพื่อนแล้ว');
  openContacts();
  loadConversations().catch(() => {});
}

function renderFriendNotes(friends) {
  document.getElementById('friendNotes').innerHTML = friends.slice(0, 5).map((friend) => `<button class="note-card" data-note-user="${friend.id}"><span class="note-avatar">${friend.username.slice(0, 2).toUpperCase()}</span><strong>${escapeHtml(friend.username)}</strong></button>`).join('');
}

function renderInboxNotes(friends) {
  document.getElementById('inboxFriendNotes').innerHTML = friends.slice(0, 6).map((friend) => `<button class="inbox-note" data-note-user="${friend.id}"><span class="note-avatar">${friend.username.slice(0, 2).toUpperCase()}</span><strong>${escapeHtml(friend.username)}</strong></button>`).join('');
  document.querySelectorAll('.inbox-note[data-note-user]').forEach((button) => button.addEventListener('click', () => {
    const friend = friends.find((item) => item.id === button.dataset.noteUser);
    if (friend) selectContact(friend);
  }));
}

function renderFriendRequests(requests) {
  const section = document.getElementById('friendRequestsSection');
  document.getElementById('requestCount').textContent = requests.length ? `(${requests.length})` : '';
  section.hidden = !requests.length;
  document.getElementById('requestsList').innerHTML = requests.map((person) => `<div class="request-row"><span class="person-avatar">${person.username.slice(0, 2).toUpperCase()}</span><span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>ต้องการเป็นเพื่อนกับคุณ</small></span><button class="request-action accept" data-request-id="${person.id}">รับ</button><button class="request-action decline" data-request-id="${person.id}">ปฏิเสธ</button></div>`).join('');
  document.querySelectorAll('.request-action.accept').forEach((button) => button.addEventListener('click', () => respondToFriendRequest(button.dataset.requestId, true)));
  document.querySelectorAll('.request-action.decline').forEach((button) => button.addEventListener('click', () => respondToFriendRequest(button.dataset.requestId, false)));
}

async function respondToFriendRequest(friendId, accepted) {
  const response = await fetch(`/api/contacts/${friendId}/${accepted ? 'accept' : 'request'}`, { method: accepted ? 'POST' : 'DELETE' });
  if (response.ok) { showToast(accepted ? 'รับคำขอเป็นเพื่อนแล้ว' : 'ปฏิเสธคำขอแล้ว'); openContacts(); }
  else showToast((await response.json()).error || 'ดำเนินการไม่สำเร็จ');
}

async function addFriend(friendId) {
  const response = await fetch(`/api/contacts/${friendId}`, { method: 'POST' });
  if (response.ok) { showToast('ส่งคำขอเป็นเพื่อนแล้ว'); openContacts(); }
  else showToast((await response.json()).error || 'ส่งคำขอไม่สำเร็จ');
}

function selectContact(contact) {
  chatSelectionToken += 1;
  selectedContact = contact;
  document.getElementById('chatAvatar').textContent = contact.username.slice(0, 2).toUpperCase();
  document.getElementById('chatContactName').textContent = contact.username;
  document.getElementById('chatContactStatus').textContent = contact.online ? 'ออนไลน์อยู่' : 'ออฟไลน์';
  clearChatArea();
  closeContacts();
  document.getElementById('appShell').classList.add('mobile-chat-open');
  activeRoomId = `direct:${[currentUser.id, contact.id].sort().join(':')}`;
  fetch(`/api/conversations/${contact.id}/read`, { method: 'POST' }).then(() => loadConversations()).catch(() => {});
  if (socket.connected) socket.emit('join-room', { peerId: contact.id, selectionToken: chatSelectionToken });
}

function clearChatArea() {
  oldestMessageTimestamp = null;
  replyToMessageId = null;
  chatArea.innerHTML = '<button type="button" class="load-older" id="loadOlderMessages" hidden>โหลดข้อความเก่า</button><div class="date-divider"><span>Today</span></div>';
  document.getElementById('loadOlderMessages').addEventListener('click', loadOlderMessages);
}

function renderConversationList(conversations) {
  const container = document.getElementById('conversationList');
  if (!conversations.length) {
    container.innerHTML = '<div class="conversation-empty">ยังไม่มีประวัติแชท เลือกเพื่อนจาก Contacts เพื่อเริ่มการสนทนา</div>';
    return;
  }
  container.innerHTML = conversations.map((person) => `<button class="conversation${selectedContact?.id === person.id ? ' active' : ''}" data-conversation-id="${person.id}"><span class="avatar violet">${person.username.slice(0, 2).toUpperCase()}${person.online ? '<span class="online-dot"></span>' : ''}</span><span class="conversation-copy"><strong>${escapeHtml(person.username)}</strong><span>${escapeHtml(person.lastText || 'เริ่มการสนทนา')}</span></span>${person.unreadCount ? `<b class="unread-count">${person.unreadCount > 99 ? '99+' : person.unreadCount}</b>` : ''}<time>${person.lastCreatedAt ? formatTime(person.lastCreatedAt) : ''}</time></button>`).join('');
  container.querySelectorAll('[data-conversation-id]').forEach((button) => button.addEventListener('click', async () => {
    const response = await fetch('/api/contacts');
    const result = await response.json();
    const contact = result.friends.find((friend) => friend.id === button.dataset.conversationId);
    if (contact) selectContact(contact);
  }));
}

function renderSearchResults(messages) {
  const container = document.getElementById('conversationList');
  if (!messages.length) {
    container.innerHTML = '<div class="conversation-empty">ไม่พบข้อความที่ค้นหา</div>';
    return;
  }
  container.innerHTML = messages.map((message) => {
    const ids = message.roomId.split(':').slice(1);
    const friendId = ids.find((id) => id !== currentUser?.id) || '';
    return `<button class="conversation search-result" data-search-contact="${friendId}"><span class="avatar violet">${escapeHtml(message.senderName.slice(0, 2).toUpperCase())}</span><span class="conversation-copy"><strong>${escapeHtml(message.senderName)}</strong><span>${escapeHtml(message.text)}</span></span><time>${formatTime(message.timestamp)}</time></button>`;
  }).join('');
  container.querySelectorAll('[data-search-contact]').forEach((button) => button.addEventListener('click', async () => {
    const response = await fetch('/api/contacts');
    if (!response.ok) return;
    const contact = (await response.json()).friends.find((friend) => friend.id === button.dataset.searchContact);
    if (contact) selectContact(contact);
  }));
}

async function loadConversations() {
  const response = await fetch('/api/conversations');
  if (response.ok) renderConversationList((await response.json()).conversations);
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  socket.disconnect();
  currentUser = null;
  profileMenu.classList.remove('visible');
  profileMenu.setAttribute('aria-hidden', 'true');
  closeSettings();
  authScreen.classList.add('visible');
  authForm.reset();
}

async function bootstrapAuth() {
  const response = await fetch('/api/auth/me');
  const result = await response.json();
  if (result.authenticated) enterApp(result.user);
}

function enterApp(user) {
  currentUser = user;
  const initials = user.username.slice(0, 1).toUpperCase();
  document.getElementById('currentUser').textContent = `Signed in as ${user.username}`;
  document.getElementById('railAvatar').textContent = initials;
  document.getElementById('settingsAvatar').textContent = initials;
  document.getElementById('settingsUsername').textContent = user.username;
  document.getElementById('mobileUsername').textContent = user.username;
  document.getElementById('mobileNavAvatar').textContent = initials;
  document.getElementById('noteAvatar').textContent = initials;
  document.getElementById('inboxNoteAvatar').textContent = initials;
  refreshFriendRequestBadge();
  fetch('/api/contacts').then((response) => response.ok ? response.json() : null).then((contacts) => {
    if (contacts) renderInboxNotes(contacts.friends);
  }).catch(() => {});
  loadConversations().catch(() => {});
  authScreen.classList.remove('visible');
  document.getElementById('appShell').classList.remove('mobile-chat-open');
  if (!socket.connected) loadWebRtcConfig().finally(() => socket.connect());
}

socket.on('connect', () => {
  if (selectedContact) socket.emit('join-room', { peerId: selectedContact.id, selectionToken: chatSelectionToken });
});
socket.on('connect_error', () => showToast('Please sign in again'));
socket.on('room-joined', ({ participantCount }) => {
  document.getElementById('chatContactStatus').textContent = participantCount > 1 ? 'ออนไลน์อยู่' : 'ออฟไลน์';
});
socket.on('peer-joined', ({ username: peerName }) => showToast(`${peerName} is online`));
socket.on('chat-history', ({ messages, selectionToken }) => {
  if (selectionToken !== chatSelectionToken) return;
  oldestMessageTimestamp = messages[0]?.timestamp || null;
  const loadOlderButton = document.getElementById('loadOlderMessages');
  if (loadOlderButton) loadOlderButton.hidden = messages.length < 200;
  messages.forEach((message) => {
    let attachment = null;
    try { attachment = message.attachmentJson ? JSON.parse(message.attachmentJson) : null; } catch (_error) {}
    renderMessage({ ...message, attachment, deleted: Boolean(message.deletedAt), edited: Boolean(message.editedAt) });
  });
});
socket.on('chat-error', ({ message }) => showToast(message));
socket.on('peer-left', () => { if (callModal.classList.contains('visible')) endCall(false); });

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket.connected || !selectedContact) return;
  socket.emit('chat-message', { text, replyTo: replyToMessageId });
  messageInput.value = '';
  replyToMessageId = null;
  messageInput.focus();
});

socket.on('message-reaction', ({ messageId, reactions }) => {
  const row = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (row) renderReactions(row, reactions);
});

messageInput.addEventListener('input', () => {
  if (!socket.connected || !selectedContact) return;
  socket.emit('typing', { active: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit('typing', { active: false }), 900);
});

async function uploadAttachment(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const response = await fetch('/api/uploads', { method: 'POST', body: formData });
    const attachment = await response.json();
    if (!response.ok) throw new Error(attachment.error || 'อัปโหลดไฟล์ไม่สำเร็จ');
    socket.emit('chat-message', { text: attachment.name, attachment });
  } catch (error) {
    showToast(error.message);
  }
}

document.getElementById('heartButton').addEventListener('click', () => {
  if (socket.connected && selectedContact) socket.emit('chat-message', { text: '❤️' });
});

socket.on('chat-message', (message) => {
  socket.emit('typing', { active: false });
  renderMessage(message);
  loadConversations().catch(() => {});
  if (message.senderId !== currentUser?.id && (!selectedContact || message.senderId !== selectedContact.id)) notifyIncomingMessage(message);
});
socket.on('message-edited', ({ messageId, text, editedAt }) => {
  const row = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!row) return;
  row.querySelector('.message-bubble').textContent = text;
  row.querySelector('.message-meta').textContent = `${formatTime(editedAt)} (แก้ไขแล้ว)`;
});
socket.on('message-deleted', ({ messageId }) => {
  const row = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!row) return;
  row.remove();
});
socket.on('typing', ({ active, username }) => {
  if (!selectedContact) return;
  document.getElementById('chatContactStatus').textContent = active ? `${username} กำลังพิมพ์...` : (selectedContact.online ? 'ออนไลน์อยู่' : 'ออฟไลน์');
});

function notifyIncomingMessage(message) {
  const preferences = JSON.parse(localStorage.getItem('direct-preferences') || '{}');
  if (preferences.doNotDisturb) return;
  if (preferences.sound !== false) {
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.frequency.value = 660; gain.gain.value = 0.04;
      oscillator.start(); oscillator.stop(context.currentTime + 0.08);
    } catch (_error) {}
  }
  if (document.hidden && 'Notification' in window) {
    if (Notification.permission === 'granted') new Notification(message.senderName || 'ข้อความใหม่', { body: message.text });
    else if (Notification.permission === 'default') Notification.requestPermission();
  }
}

document.getElementById('audioCallButton').addEventListener('click', () => startCall('audio'));
document.getElementById('videoCallButton').addEventListener('click', () => startCall('video'));
document.getElementById('endCallButton').addEventListener('click', () => endCall(true));
acceptCallButton.addEventListener('click', acceptIncomingCall);
rejectCallButton.addEventListener('click', rejectIncomingCall);
document.getElementById('muteButton').addEventListener('click', toggleMicrophone);
document.getElementById('cameraButton').addEventListener('click', toggleCamera);
document.getElementById('shareScreenButton').addEventListener('click', shareScreen);

async function startCall(mode) {
  if (peerConnection) return;
  if (!selectedContact || !activeRoomId) return showToast('เลือกเพื่อนก่อนเริ่มโทร');
  activeCallMode = mode;
  isCaller = true;
  openCallModal('Calling...', 'Starting camera and microphone...');
  try {
    // WebRTC requests local media before the SDP handshake begins.
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
    showLocalMedia();
    createPeerConnection();
    socket.emit('call-user', { mode });
    callStatus.textContent = 'Calling...';
    voiceStatus.textContent = 'กำลังรอเพื่อนรับสาย';
  } catch (error) {
    endCall(false);
    showToast(error.name === 'NotAllowedError' ? 'Camera or microphone permission was denied' : 'Media devices are not available');
  }
}

socket.on('incoming-call', async ({ callerId, callId, callerName, mode }) => {
  if (peerConnection) return;
  activePeerId = callerId;
  activeCallMode = mode;
  isCaller = false;
  pendingIncomingCall = { callerId, callId, callerName, mode };
  openCallModal('Incoming call', `${callerName} กำลังโทรเข้า`);
  acceptCallButton.classList.add('visible');
  rejectCallButton.classList.add('visible');
});

async function acceptIncomingCall() {
  if (!pendingIncomingCall) return;
  const { callerId, callId, mode } = pendingIncomingCall;
  pendingIncomingCall = null;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
    showLocalMedia();
    createPeerConnection();
    socket.emit('call-accepted', { targetId: callerId, callId });
  } catch (error) {
    endCall(true);
    showToast(error.name === 'NotAllowedError' ? 'Camera or microphone permission was denied' : 'Media devices are not available');
  }
}

function rejectIncomingCall() {
  if (pendingIncomingCall) socket.emit('call-rejected', { targetId: pendingIncomingCall.callerId, callId: pendingIncomingCall.callId });
  pendingIncomingCall = null;
  endCall(false);
}

// The caller creates an SDP offer after the callee has accepted the call.
socket.on('call-accepted', async ({ senderId }) => {
  activePeerId = senderId;
  reconnectAttempts = 0;
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('webrtc-offer', { targetId: senderId, description: peerConnection.localDescription });
});

socket.on('webrtc-offer', async ({ senderId, description }) => {
  activePeerId = senderId;
  await setRemoteDescription(description);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('webrtc-answer', { targetId: senderId, description: peerConnection.localDescription });
  updateCallStatus('Connected');
});

socket.on('webrtc-answer', async ({ description }) => {
  await setRemoteDescription(description);
  updateCallStatus('Connected');
});

socket.on('call-rejected', () => {
  endCall(false);
  showToast('เพื่อนปฏิเสธสาย');
});
socket.on('call-busy', () => {
  endCall(false);
  showToast('เพื่อนกำลังคุยสายอื่นอยู่');
});

// ICE candidates describe reachable network paths. STUN helps peers discover
// public addresses; the media packets then flow directly over UDP when possible.
socket.on('ice-candidate', async ({ candidate }) => {
  if (!peerConnection || !candidate) return;
  if (!peerConnection.remoteDescription) {
    pendingIceCandidates.push(candidate);
    return;
  }
  await peerConnection.addIceCandidate(candidate);
});

socket.on('call-ended', () => {
  endCall(false);
  showToast('Call ended');
});

function createPeerConnection() {
  pendingIceCandidates = [];
  peerConnection = new RTCPeerConnection(rtcConfiguration);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate && activePeerId) socket.emit('ice-candidate', { targetId: activePeerId, candidate });
  };
  peerConnection.ontrack = ({ streams }) => {
    remoteVideo.srcObject = streams[0];
    remoteVideo.classList.remove('hidden');
    if (activeCallMode === 'video') voicePlaceholder.classList.add('hidden');
  };
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection.connectionState === 'connected') updateCallStatus('Connected');
    if (peerConnection.connectionState === 'failed' && isCaller && reconnectAttempts < 1) {
      reconnectAttempts += 1;
      updateCallStatus('Reconnecting...');
      peerConnection.createOffer({ iceRestart: true }).then(async (offer) => {
        await peerConnection.setLocalDescription(offer);
        socket.emit('webrtc-offer', { targetId: activePeerId, description: peerConnection.localDescription });
      }).catch(() => updateCallStatus('Connection interrupted'));
    } else if (['failed', 'disconnected'].includes(peerConnection.connectionState)) updateCallStatus('Connection interrupted');
  };
}

async function setRemoteDescription(description) {
  await peerConnection.setRemoteDescription(description);
  const candidates = pendingIceCandidates;
  pendingIceCandidates = [];
  await Promise.all(candidates.map((candidate) => peerConnection.addIceCandidate(candidate)));
}

function attachLongPress(target, onLongPress) {
  let timer = null;
  let suppressTimer = null;
  let triggered = false;
  let suppressContext = false;
  let startX = 0;
  let startY = 0;
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  target.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    triggered = false;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    clearTimer();
    timer = setTimeout(() => {
      triggered = true;
      suppressContext = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => { suppressContext = false; }, 1200);
      if (navigator.vibrate) navigator.vibrate(10);
      onLongPress();
    }, 450);
  }, { passive: true });
  target.addEventListener('touchmove', (event) => {
    if (!timer) return;
    const touch = event.touches[0];
    if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) clearTimer();
  }, { passive: true });
  target.addEventListener('touchend', (event) => {
    clearTimer();
    if (triggered) {
      triggered = false;
      event.preventDefault();
    }
  }, { passive: false });
  target.addEventListener('touchcancel', clearTimer);
  target.addEventListener('contextmenu', (event) => {
    if (suppressContext) event.preventDefault();
  });
}

function renderMessage(message) {
  const isMine = message.senderId === currentUser?.id;
  if (!selectedContact) return;
  const row = document.createElement('div');
  row.className = `message-row${isMine ? ' mine' : ''}`;
  row.dataset.messageId = message.id;
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = message.deleted ? 'ข้อความถูกลบแล้ว' : message.text;
  if (message.replyTo) {
    const replyLabel = document.createElement('small');
    replyLabel.className = 'message-reply';
    replyLabel.textContent = 'ตอบกลับข้อความ';
    bubble.prepend(replyLabel, document.createElement('br'));
  }
  if (message.attachment?.url) {
    const link = document.createElement('a');
    link.href = message.attachment.url;
    link.target = '_blank';
    link.rel = 'noopener';
    if (message.attachment.type?.startsWith('image/')) {
      const image = document.createElement('img');
      image.className = 'message-attachment-image';
      image.src = message.attachment.url;
      image.alt = message.attachment.name || 'รูปภาพที่แนบ';
      image.loading = 'lazy';
      link.append(image);
    } else {
      link.textContent = `เปิดไฟล์: ${message.attachment.name}`;
    }
    bubble.append(document.createElement('br'), link);
  }
  const meta = document.createElement('time');
  meta.className = 'message-meta';
  meta.textContent = formatTime(message.timestamp);
  row.append(bubble, meta);
  if (message.reactionJson) renderReactions(row, message.reactionJson);
  if (isMine && !message.deleted) {
    const tools = document.createElement('div');
    tools.className = 'message-tools';
    tools.innerHTML = '<button type="button" class="message-more" aria-label="ตัวเลือกข้อความ" title="ตัวเลือกข้อความ"><i class="fa-solid fa-ellipsis"></i></button><div class="message-menu"><button type="button" data-message-action="reply"><i class="fa-solid fa-reply"></i> ตอบกลับ</button><button type="button" data-message-action="react"><i class="fa-solid fa-heart"></i> ถูกใจ</button><button type="button" data-message-action="edit"><i class="fa-solid fa-pen"></i> แก้ไข</button><button type="button" class="delete-message" data-message-action="delete"><i class="fa-solid fa-trash"></i> ลบ</button></div>';
    tools.querySelector('.message-more').addEventListener('click', (event) => {
      event.stopPropagation();
      document.querySelectorAll('.message-tools.open, .message-tools.visible').forEach((item) => { if (item !== tools) item.classList.remove('open', 'visible'); });
      tools.classList.toggle('open');
    });
    tools.querySelector('[data-message-action="reply"]').addEventListener('click', () => { replyToMessageId = message.id; messageInput.focus(); showToast('กำลังตอบกลับข้อความ'); tools.classList.remove('open', 'visible'); });
    tools.querySelector('[data-message-action="react"]').addEventListener('click', () => { socket.emit('react-message', { messageId: message.id, emoji: '❤️' }); tools.classList.remove('open', 'visible'); });
    tools.querySelector('[data-message-action="edit"]').addEventListener('click', () => {
      const text = window.prompt('แก้ไขข้อความ', message.text);
      if (text?.trim() && socket.connected) socket.emit('edit-message', { messageId: message.id, text });
      tools.classList.remove('open', 'visible');
    });
    tools.querySelector('[data-message-action="delete"]').addEventListener('click', () => {
      openDeleteConfirm(message.id);
      tools.classList.remove('open', 'visible');
    });
    attachLongPress(bubble, () => tools.classList.add('visible'));
    row.append(tools);
  }
  if (!isMine && !message.deleted) {
    const actions = document.createElement('button');
    actions.type = 'button';
    actions.className = 'message-reaction-button';
    actions.title = 'React';
    actions.textContent = '❤️';
    actions.addEventListener('click', () => socket.emit('react-message', { messageId: message.id, emoji: '❤️' }));
    row.append(actions);
  }
  if (message.prepend) {
    const firstMessage = chatArea.querySelector('.message-row');
    if (firstMessage) chatArea.insertBefore(row, firstMessage);
    else chatArea.appendChild(row);
  } else {
    chatArea.appendChild(row);
    chatArea.scrollTop = chatArea.scrollHeight;
  }
}

function openDeleteConfirm(messageId) {
  pendingDeleteMessageId = messageId;
  deleteConfirmModal.classList.add('visible');
  deleteConfirmModal.setAttribute('aria-hidden', 'false');
  confirmDeleteButton.focus();
}

function closeDeleteConfirm() {
  pendingDeleteMessageId = null;
  deleteConfirmModal.classList.remove('visible');
  deleteConfirmModal.setAttribute('aria-hidden', 'true');
}

function renderReactions(row, reactions) {
  let parsed = reactions;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed || '{}'); } catch (_error) { parsed = {}; }
  }
  row.querySelector('.message-reactions')?.remove();
  const values = Object.values(parsed || {});
  if (!values.length) return;
  const badge = document.createElement('span');
  badge.className = 'message-reactions';
  badge.textContent = values.join('');
  row.append(badge);
}

async function loadOlderMessages() {
  if (!selectedContact || !oldestMessageTimestamp) return;
  const response = await fetch(`/api/conversations/${selectedContact.id}/messages?limit=50&before=${encodeURIComponent(oldestMessageTimestamp)}`);
  if (!response.ok) return showToast('โหลดข้อความเก่าไม่สำเร็จ');
  const result = await response.json();
  const previousHeight = chatArea.scrollHeight;
  result.messages.forEach((message) => {
    let attachment = null;
    try { attachment = message.attachmentJson ? JSON.parse(message.attachmentJson) : null; } catch (_error) {}
    renderMessage({ ...message, attachment, deleted: Boolean(message.deletedAt), edited: Boolean(message.editedAt), prepend: true });
  });
  if (result.messages[0]) oldestMessageTimestamp = result.messages[0].timestamp;
  document.getElementById('loadOlderMessages').hidden = !result.hasMore;
  chatArea.scrollTop += chatArea.scrollHeight - previousHeight;
}

function formatTime(timestamp) {
  const value = typeof timestamp === 'string' && !timestamp.includes('T') && !timestamp.endsWith('Z') ? `${timestamp.replace(' ', 'T')}Z` : timestamp;
  return new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function openCallModal(title, status) { const contactName = selectedContact?.username || 'เพื่อน'; callTitle.textContent = contactName; callStatus.textContent = title; voiceStatus.textContent = status; callModal.classList.add('visible'); callModal.setAttribute('aria-hidden', 'false'); }
function updateCallStatus(status) { callStatus.textContent = status; voiceStatus.textContent = status; }
function showLocalMedia() { localVideo.srcObject = localStream; localVideo.classList.toggle('hidden', activeCallMode !== 'video'); remoteVideo.classList.toggle('hidden', activeCallMode !== 'video'); voicePlaceholder.classList.toggle('hidden', activeCallMode === 'video'); }

function endCall(notifyPeer) {
  if (notifyPeer && socket.connected) socket.emit('end-call');
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (screenStream) screenStream.getTracks().forEach((track) => track.stop());
  peerConnection = null; localStream = null; activePeerId = null; isCaller = false; pendingIceCandidates = [];
  screenStream = null;
  pendingIncomingCall = null; acceptCallButton.classList.remove('visible'); rejectCallButton.classList.remove('visible');
  remoteVideo.srcObject = null; localVideo.srcObject = null;
  callModal.classList.remove('visible'); callModal.setAttribute('aria-hidden', 'true');
}

async function shareScreen() {
  if (!peerConnection || activeCallMode !== 'video') return showToast('เปิดวิดีโอคอลก่อนแชร์หน้าจอ');
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find((item) => item.track?.kind === 'video');
    if (!sender) return;
    await sender.replaceTrack(screenTrack);
    localVideo.srcObject = screenStream;
    screenTrack.addEventListener('ended', async () => {
      const cameraTrack = localStream?.getVideoTracks()[0];
      if (cameraTrack && peerConnection) {
        await sender.replaceTrack(cameraTrack);
        localVideo.srcObject = localStream;
      }
    }, { once: true });
  } catch (error) {
    if (error.name !== 'NotAllowedError') showToast('แชร์หน้าจอไม่สำเร็จ');
  }
}

function toggleMicrophone() {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  document.getElementById('muteButton').classList.toggle('off', !track.enabled);
  document.getElementById('muteButton').innerHTML = `<i class="fa-solid fa-microphone${track.enabled ? '' : '-slash'}"></i>`;
}
function toggleCamera() {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  document.getElementById('cameraButton').classList.toggle('off', !track.enabled);
  document.getElementById('cameraButton').innerHTML = `<i class="fa-solid fa-video${track.enabled ? '' : '-slash'}"></i>`;
}
function showToast(message) { toast.textContent = message; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800); }

async function loadWebRtcConfig() {
  try {
    const response = await fetch('/api/webrtc-config');
    if (response.ok) {
      const config = await response.json();
      if (config.iceServers?.length) rtcConfiguration = { iceServers: config.iceServers };
    }
  } catch (_error) {
    // STUN remains available when optional TURN configuration is unavailable.
  }
}

bootstrapAuth().catch(() => showToast('Could not check your session'));
loadPreferences();
setInterval(refreshFriendRequestBadge, 15000);
