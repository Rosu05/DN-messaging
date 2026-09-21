const socket = io({ autoConnect: false });
let currentUser = null;
let selectedContact = null;
let activeRoomId = null;
let isRegisterMode = false;
const rtcConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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

let peerConnection = null;
let localStream = null;
let activePeerId = null;
let activeCallMode = 'video';
let isCaller = false;
let toastTimer = null;

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
}));

document.getElementById('menuLogoutButton').addEventListener('click', logout);
document.getElementById('contactsButton').addEventListener('click', openContacts);
document.getElementById('contactsClose').addEventListener('click', closeContacts);
contactsModal.addEventListener('click', (event) => { if (event.target === contactsModal) closeContacts(); });

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
    renderFriendRequests(result.requests);
    setContactBadge(result.requestCount);
  } catch (_error) {
    document.getElementById('friendsList').innerHTML = '<p class="empty-contacts">โหลดรายชื่อไม่สำเร็จ</p>';
  }
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
  badge.textContent = count;
  badge.hidden = !count;
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
    return `<button class="person-row" data-user-id="${person.id}"><span class="person-avatar">${initials}</span><span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>${showAddButton ? 'แนะนำสำหรับคุณ' : 'เพื่อนของคุณ'}</small></span>${showAddButton ? '<span class="add-person">เพิ่ม</span>' : '<i class="fa-solid fa-chevron-right"></i>'}</button>`;
  }).join('');
  container.querySelectorAll('.person-row').forEach((row) => {
    row.addEventListener('click', () => showAddButton ? addFriend(row.dataset.userId) : selectContact(people.find((person) => person.id === row.dataset.userId)));
  });
}

function renderFriendNotes(friends) {
  document.getElementById('friendNotes').innerHTML = friends.slice(0, 5).map((friend) => `<button class="note-card" data-note-user="${friend.id}"><span class="note-avatar">${friend.username.slice(0, 2).toUpperCase()}</span><strong>${escapeHtml(friend.username)}</strong></button>`).join('');
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
}

async function addFriend(friendId) {
  const response = await fetch(`/api/contacts/${friendId}`, { method: 'POST' });
  if (response.ok) { showToast('เพิ่มเพื่อนแล้ว'); openContacts(); }
}

function selectContact(contact) {
  selectedContact = contact;
  document.getElementById('chatAvatar').textContent = contact.username.slice(0, 2).toUpperCase();
  document.getElementById('chatContactName').textContent = contact.username;
  document.getElementById('chatContactStatus').textContent = contact.online ? 'ออนไลน์อยู่' : 'ออฟไลน์';
  clearChatArea();
  closeContacts();
  activeRoomId = `direct:${[currentUser.id, contact.id].sort().join(':')}`;
  if (socket.connected) socket.emit('join-room', { peerId: contact.id });
}

function clearChatArea() {
  chatArea.innerHTML = '<div class="date-divider"><span>Today</span></div>';
}

function renderConversationList(conversations) {
  const container = document.getElementById('conversationList');
  if (!conversations.length) {
    container.innerHTML = '<div class="conversation-empty">ยังไม่มีประวัติแชท เลือกเพื่อนจาก Contacts เพื่อเริ่มการสนทนา</div>';
    return;
  }
  container.innerHTML = conversations.map((person) => `<button class="conversation${selectedContact?.id === person.id ? ' active' : ''}" data-conversation-id="${person.id}"><span class="avatar violet">${person.username.slice(0, 2).toUpperCase()}${person.online ? '<span class="online-dot"></span>' : ''}</span><span class="conversation-copy"><strong>${escapeHtml(person.username)}</strong><span>${escapeHtml(person.lastText || 'เริ่มการสนทนา')}</span></span><time>${person.lastCreatedAt ? formatTime(person.lastCreatedAt) : ''}</time></button>`).join('');
  container.querySelectorAll('[data-conversation-id]').forEach((button) => button.addEventListener('click', async () => {
    const response = await fetch('/api/contacts');
    const result = await response.json();
    const contact = result.friends.find((friend) => friend.id === button.dataset.conversationId);
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
  document.getElementById('noteAvatar').textContent = initials;
  refreshFriendRequestBadge();
  loadConversations().catch(() => {});
  authScreen.classList.remove('visible');
  if (!socket.connected) socket.connect();
}

socket.on('connect', () => {
  if (selectedContact) socket.emit('join-room', { peerId: selectedContact.id });
});
socket.on('connect_error', () => showToast('Please sign in again'));
socket.on('room-joined', ({ participantCount }) => {
  document.getElementById('chatContactStatus').textContent = participantCount > 1 ? 'ออนไลน์อยู่' : 'ออฟไลน์';
});
socket.on('peer-joined', ({ username: peerName }) => showToast(`${peerName} is online`));
socket.on('chat-history', (messages) => messages.forEach((message) => renderMessage(message)));
socket.on('chat-error', ({ message }) => showToast(message));
socket.on('peer-left', () => { if (callModal.classList.contains('visible')) endCall(false); });

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket.connected || !selectedContact) return;
  socket.emit('chat-message', { text });
  messageInput.value = '';
  messageInput.focus();
});

document.getElementById('heartButton').addEventListener('click', () => {
  if (socket.connected && selectedContact) socket.emit('chat-message', { text: '❤️' });
});

socket.on('chat-message', (message) => renderMessage(message));

document.getElementById('audioCallButton').addEventListener('click', () => startCall('audio'));
document.getElementById('videoCallButton').addEventListener('click', () => startCall('video'));
document.getElementById('endCallButton').addEventListener('click', () => endCall(true));
document.getElementById('muteButton').addEventListener('click', toggleMicrophone);
document.getElementById('cameraButton').addEventListener('click', toggleCamera);

async function startCall(mode) {
  if (peerConnection) return;
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
    voiceStatus.textContent = 'Waiting for Alex to answer';
  } catch (error) {
    endCall(false);
    showToast(error.name === 'NotAllowedError' ? 'Camera or microphone permission was denied' : 'Media devices are not available');
  }
}

socket.on('incoming-call', async ({ callerId, callerName, mode }) => {
  if (peerConnection) return;
  const accepted = window.confirm(`${callerName} is calling. Accept ${mode} call?`);
  if (!accepted) {
    socket.emit('end-call');
    return;
  }
  activePeerId = callerId;
  activeCallMode = mode;
  isCaller = false;
  openCallModal('Incoming call', 'Connecting...');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' });
    showLocalMedia();
    createPeerConnection();
    socket.emit('call-accepted', { targetId: callerId });
  } catch (error) {
    endCall(true);
    showToast(error.name === 'NotAllowedError' ? 'Camera or microphone permission was denied' : 'Media devices are not available');
  }
});

// The caller creates an SDP offer after the callee has accepted the call.
socket.on('call-accepted', async ({ senderId }) => {
  activePeerId = senderId;
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('webrtc-offer', { targetId: senderId, description: peerConnection.localDescription });
});

socket.on('webrtc-offer', async ({ senderId, description }) => {
  activePeerId = senderId;
  await peerConnection.setRemoteDescription(description);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('webrtc-answer', { targetId: senderId, description: peerConnection.localDescription });
  updateCallStatus('Connected');
});

socket.on('webrtc-answer', async ({ description }) => {
  await peerConnection.setRemoteDescription(description);
  updateCallStatus('Connected');
});

// ICE candidates describe reachable network paths. STUN helps peers discover
// public addresses; the media packets then flow directly over UDP when possible.
socket.on('ice-candidate', async ({ candidate }) => {
  if (peerConnection && candidate) await peerConnection.addIceCandidate(candidate);
});

socket.on('call-ended', () => {
  endCall(false);
  showToast('Call ended');
});

function createPeerConnection() {
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
    if (['failed', 'disconnected'].includes(peerConnection.connectionState)) updateCallStatus('Connection interrupted');
  };
}

function renderMessage(message) {
  const isMine = message.senderId === currentUser?.id;
  if (!selectedContact) return;
  const row = document.createElement('div');
  row.className = `message-row${isMine ? ' mine' : ''}`;
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = message.text;
  const meta = document.createElement('time');
  meta.className = 'message-meta';
  meta.textContent = formatTime(message.timestamp);
  row.append(bubble, meta);
  chatArea.appendChild(row);
  chatArea.scrollTop = chatArea.scrollHeight;
  loadConversations().catch(() => {});
}

function formatTime(timestamp) { return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp)); }
function openCallModal(title, status) { const contactName = selectedContact?.username || 'เพื่อน'; callTitle.textContent = contactName; callStatus.textContent = title; voiceStatus.textContent = status; callModal.classList.add('visible'); callModal.setAttribute('aria-hidden', 'false'); }
function updateCallStatus(status) { callStatus.textContent = status; voiceStatus.textContent = status; }
function showLocalMedia() { localVideo.srcObject = localStream; localVideo.classList.toggle('hidden', activeCallMode !== 'video'); remoteVideo.classList.toggle('hidden', activeCallMode !== 'video'); voicePlaceholder.classList.toggle('hidden', activeCallMode === 'video'); }

function endCall(notifyPeer) {
  if (notifyPeer && socket.connected) socket.emit('end-call');
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  peerConnection = null; localStream = null; activePeerId = null; isCaller = false;
  remoteVideo.srcObject = null; localVideo.srcObject = null;
  callModal.classList.remove('visible'); callModal.setAttribute('aria-hidden', 'true');
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

bootstrapAuth().catch(() => showToast('Could not check your session'));
setInterval(refreshFriendRequestBadge, 15000);
