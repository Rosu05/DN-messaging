const socket = io({ autoConnect: false });
let currentUser = null;
let selectedContact = null;
let activeRoomId = null;
let chatSelectionToken = 0;
let isRegisterMode = false;
let longPressGuardUntil = 0;
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
const groupModal = document.getElementById('groupModal');
const groupForm = document.getElementById('groupForm');
const groupNameInput = document.getElementById('groupNameInput');
const groupMembersList = document.getElementById('groupMembersList');
const groupError = document.getElementById('groupError');
const groupDetailsModal = document.getElementById('groupDetailsModal');
const groupDetailsMembers = document.getElementById('groupDetailsMembers');
const groupDetailsMeta = document.getElementById('groupDetailsMeta');
const groupDetailsError = document.getElementById('groupDetailsError');
const editModal = document.getElementById('editModal');
const editForm = document.getElementById('editForm');
const editModalTitle = document.getElementById('editModalTitle');
const editModalError = document.getElementById('editModalError');
const editAvatarField = document.getElementById('editAvatarField');
const editAvatarInput = document.getElementById('editAvatarInput');
const editUsernameField = document.getElementById('editUsernameField');
const editEmailField = document.getElementById('editEmailField');
const editMessageField = document.getElementById('editMessageField');
const editUsernameInput = document.getElementById('editUsernameInput');
const editEmailInput = document.getElementById('editEmailInput');
const editMessageInput = document.getElementById('editMessageInput');
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
  if (Date.now() < longPressGuardUntil) return;
  if (!event.target.closest('.message-tools')) document.querySelectorAll('.message-tools.open').forEach((item) => item.classList.remove('open'));
});

deleteConfirmModal.addEventListener('click', (event) => { if (event.target === deleteConfirmModal) closeDeleteConfirm(); });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && deleteConfirmModal.classList.contains('visible')) closeDeleteConfirm();
});

let peerConnection = null;
let localStream = null;
let screenStream = null;
let pendingIceCandidates = [];
let activePeerId = null;
let activeCallId = null;
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
let emojiPickerOpen = false;
let pendingConfirmationAction = null;
let editModalMode = null;
let editMessageId = null;
let groupModalMode = 'create';
let activeGroupId = null;
const presenceMap = new Map();

function showConfirmModal({ title, description, confirmText, onConfirm, cancelText = 'ยกเลิก' }) {
  const titleEl = document.getElementById('deleteConfirmTitle');
  const descriptionEl = document.getElementById('deleteConfirmDescription');
  const confirmButton = document.getElementById('confirmDeleteButton');
  const cancelButton = document.getElementById('cancelDeleteButton');

  titleEl.textContent = title;
  descriptionEl.textContent = description;
  confirmButton.textContent = confirmText || 'ยืนยัน';
  cancelButton.textContent = cancelText;
  pendingConfirmationAction = onConfirm || null;
  deleteConfirmModal.classList.add('visible');
  deleteConfirmModal.setAttribute('aria-hidden', 'false');
  confirmButton.focus();
}

function closeConfirmModal() {
  pendingDeleteMessageId = null;
  pendingConfirmationAction = null;
  deleteConfirmModal.classList.remove('visible');
  deleteConfirmModal.setAttribute('aria-hidden', 'true');
}

confirmDeleteButton.addEventListener('click', () => {
  if (pendingConfirmationAction) {
    const callback = pendingConfirmationAction;
    pendingConfirmationAction = null;
    callback();
  }
  closeConfirmModal();
});
cancelDeleteButton.addEventListener('click', closeConfirmModal);

function openEditModal(mode, values = {}) {
  editModalMode = mode;
  editMessageId = values.messageId || null;
  const isProfile = mode === 'profile';
  editModalTitle.textContent = isProfile ? 'แก้ไขโปรไฟล์' : 'แก้ไขข้อความ';
  editAvatarField.hidden = !isProfile;
  editUsernameField.hidden = !isProfile;
  editEmailField.hidden = !isProfile;
  editMessageField.hidden = isProfile;
  editUsernameInput.required = isProfile;
  editEmailInput.required = isProfile;
  editMessageInput.required = !isProfile;
  editUsernameInput.value = values.username || '';
  editEmailInput.value = values.email || '';
  editMessageInput.value = values.text || '';
  editAvatarInput.value = '';
  editModalError.textContent = '';
  editModal.classList.add('visible');
  editModal.setAttribute('aria-hidden', 'false');
  (isProfile ? editUsernameInput : editMessageInput).focus();
}

function closeEditModal() {
  editModalMode = null;
  editMessageId = null;
  editModal.classList.remove('visible');
  editModal.setAttribute('aria-hidden', 'true');
}

document.getElementById('editModalClose').addEventListener('click', closeEditModal);
document.getElementById('editModalCancel').addEventListener('click', closeEditModal);
editModal.addEventListener('click', (event) => { if (event.target === editModal) closeEditModal(); });
editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  editModalError.textContent = '';
  if (editModalMode === 'message') {
    const text = editMessageInput.value.trim();
    if (!text || !editMessageId || !socket.connected) return;
    socket.emit('edit-message', { messageId: editMessageId, text });
    closeEditModal();
    return;
  }
  const username = editUsernameInput.value.trim();
  const email = editEmailInput.value.trim();
  if (!username || !email) return;
  const response = await fetch('/api/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, email }) });
  const result = await response.json();
  if (!response.ok) {
    editModalError.textContent = result.error || 'แก้ไขโปรไฟล์ไม่สำเร็จ';
    return;
  }
  let updatedUser = result.user;
  if (editAvatarInput.files[0]) {
    const formData = new FormData();
    formData.append('file', editAvatarInput.files[0]);
    const avatarResponse = await fetch('/api/profile/avatar', { method: 'PATCH', body: formData });
    const avatarResult = await avatarResponse.json();
    if (!avatarResponse.ok) {
      editModalError.textContent = avatarResult.error || 'เปลี่ยนรูปโปรไฟล์ไม่สำเร็จ';
      return;
    }
    updatedUser = avatarResult.user;
  }
  closeEditModal();
  enterApp(updatedUser);
  showToast('อัปเดตโปรไฟล์แล้ว');
});

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
document.getElementById('editProfileButton').addEventListener('click', () => {
  profileMenu.classList.remove('visible');
  profileMenu.setAttribute('aria-hidden', 'true');
  openEditModal('profile', { username: currentUser?.username, email: currentUser?.email });
});
document.getElementById('contactsButton').addEventListener('click', openContacts);
document.getElementById('contactsClose').addEventListener('click', closeContacts);
contactsModal.addEventListener('click', (event) => { if (event.target === contactsModal) closeContacts(); });
document.getElementById('createGroupButton').addEventListener('click', openGroupModal);
document.getElementById('groupClose').addEventListener('click', closeGroupModal);
document.getElementById('groupCancel').addEventListener('click', closeGroupModal);
groupModal.addEventListener('click', (event) => { if (event.target === groupModal) closeGroupModal(); });
groupForm.addEventListener('submit', createGroup);
document.getElementById('groupInfoButton').addEventListener('click', openGroupDetails);
document.getElementById('groupDetailsClose').addEventListener('click', closeGroupDetails);
groupDetailsModal.addEventListener('click', (event) => { if (event.target === groupDetailsModal) closeGroupDetails(); });
document.getElementById('groupAddMembersButton').addEventListener('click', () => openGroupModal('invite'));
document.getElementById('groupLeaveButton').addEventListener('click', leaveActiveGroup);
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

document.getElementById('contactsSearchInput')?.addEventListener('input', async (event) => {
  const query = event.target.value.trim();
  await openContacts(query);
});

function closeSettings() {
  settingsModal.classList.remove('visible');
  settingsModal.setAttribute('aria-hidden', 'true');
}

async function openContacts(query = '') {
  contactsModal.classList.add('visible');
  contactsModal.setAttribute('aria-hidden', 'false');
  try {
    const url = query ? `/api/contacts?q=${encodeURIComponent(query)}` : '/api/contacts';
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    renderPeople('friendsList', result.friends, false);
    renderPeople('suggestionsList', result.suggestions, true);
    renderFriendNotes(result.friends);
    renderInboxNotes(result.friends);
    renderFriendRequests(result.requests);
    const groupInviteCount = await loadGroupInvites();
    await loadBlockedUsers();
    setContactBadge(result.requestCount, groupInviteCount);
  } catch (_error) {
    document.getElementById('friendsList').innerHTML = '<p class="empty-contacts">โหลดรายชื่อไม่สำเร็จ</p>';
  }
}

async function loadGroupInvites() {
  const section = document.getElementById('groupInvitesSection');
  const list = document.getElementById('groupInvitesList');
  const response = await fetch('/api/group-invites');
  if (!response.ok) return 0;
  const { invites } = await response.json();
  section.hidden = !invites.length;
  document.getElementById('groupInviteCount').textContent = invites.length ? `(${invites.length})` : '';
  list.innerHTML = invites.map((invite) => `<div class="request-row group-invite-row"><span class="person-avatar">G</span><span class="person-copy"><strong>${escapeHtml(invite.name)}</strong><small>เชิญโดย ${escapeHtml(invite.inviterName)}</small></span><button class="request-action accept" data-group-response="accept" data-group-id="${invite.id}">เข้าร่วม</button><button class="request-action decline" data-group-response="decline" data-group-id="${invite.id}">ปฏิเสธ</button></div>`).join('');
  list.querySelectorAll('[data-group-response]').forEach((button) => button.addEventListener('click', () => respondToGroupInvite(button.dataset.groupId, button.dataset.groupResponse === 'accept')));
  return invites.length;
}

async function respondToGroupInvite(groupId, accepted) {
  const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accepted }) });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'ดำเนินการกับคำเชิญไม่สำเร็จ');
  showToast(accepted ? 'เข้าร่วมกลุ่มแล้ว' : 'ปฏิเสธคำเชิญแล้ว');
  await loadGroupInvites();
  await loadConversations();
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
    const [contactsResponse, groupsResponse] = await Promise.all([fetch('/api/contacts'), fetch('/api/group-invites')]);
    if (!contactsResponse.ok) return;
    const contacts = await contactsResponse.json();
    const groupInvites = groupsResponse.ok ? await groupsResponse.json() : { invites: [] };
    setContactBadge(contacts.requestCount, groupInvites.invites.length);
  } catch (_error) {
    // The contacts screen will show the full error state when opened.
  }
}

function setContactBadge(count, groupInviteCount = 0) {
  const totalCount = count + groupInviteCount;
  const badge = document.getElementById('contactBadge');
  const tabBadge = document.getElementById('requestsTabBadge');
  badge.textContent = totalCount;
  badge.hidden = !totalCount;
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
  closeGroupDetails();
  closeSettings();
  profileMenu.classList.remove('visible');
  profileMenu.setAttribute('aria-hidden', 'true');
  setMessageTab('messages');
  document.querySelectorAll('.mobile-nav-button').forEach((item) => item.classList.toggle('active', item.dataset.mobileNav === 'messages'));
  document.getElementById('appShell').classList.remove('mobile-chat-open');
  document.getElementById('audioCallButton').disabled = false;
  document.getElementById('videoCallButton').disabled = false;
  document.getElementById('groupInfoButton').hidden = true;
  document.getElementById('chatAvatar').textContent = '?';
  document.getElementById('chatContactName').textContent = 'เลือกเพื่อน';
  updateChatStatusText('พร้อมเริ่มการสนทนา', false);
  chatArea.innerHTML = '<div class="date-divider"><span>วันนี้</span></div><div class="welcome-card"><div class="welcome-orb"><i class="fa-solid fa-bolt"></i></div><h3>Start the conversation</h3><p>Messages travel over a persistent TCP connection powered by Socket.io.</p></div>';
}

function closeContacts() {
  contactsModal.classList.remove('visible');
  contactsModal.setAttribute('aria-hidden', 'true');
}

async function openGroupModal(mode = 'create') {
  groupModalMode = mode;
  groupError.textContent = '';
  groupNameInput.value = '';
  document.getElementById('groupTitle').textContent = mode === 'invite' ? 'เพิ่มสมาชิกเข้ากลุ่ม' : 'สร้างแชทกลุ่ม';
  document.querySelector('#groupForm > label').hidden = mode === 'invite';
  document.querySelector('#groupForm .edit-submit').textContent = mode === 'invite' ? 'ส่งคำเชิญ' : 'สร้างกลุ่ม';
  groupMembersList.innerHTML = '<p class="empty-contacts">กำลังโหลดรายชื่อ...</p>';
  groupModal.classList.add('visible');
  groupModal.setAttribute('aria-hidden', 'false');
  try {
    const response = await fetch('/api/contacts');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    groupMembersList.innerHTML = result.friends.length ? result.friends.map((friend) => `<label class="group-member-option"><input type="checkbox" value="${friend.id}">${avatarMarkup(friend, 'person-avatar')}<span><strong>${escapeHtml(friend.username)}</strong><small>${friend.online ? 'ออนไลน์' : 'ออฟไลน์'}</small></span></label>`).join('') : '<p class="empty-contacts">ต้องมีเพื่อนก่อนจึงจะสร้างกลุ่มได้</p>';
    (mode === 'invite' ? groupMembersList : groupNameInput).focus();
  } catch (_error) {
    groupMembersList.innerHTML = '<p class="empty-contacts">โหลดรายชื่อไม่สำเร็จ</p>';
  }
}

function closeGroupModal() {
  groupModal.classList.remove('visible');
  groupModal.setAttribute('aria-hidden', 'true');
}

async function createGroup(event) {
  event.preventDefault();
  groupError.textContent = '';
  const name = groupNameInput.value.trim();
  const memberIds = [...groupMembersList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  const response = await fetch(groupModalMode === 'invite' ? `/api/groups/${encodeURIComponent(activeGroupId)}/members` : '/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(groupModalMode === 'invite' ? { memberIds } : { name, memberIds }) });
  const result = await response.json();
  if (!response.ok) {
    groupError.textContent = result.error || 'สร้างกลุ่มไม่สำเร็จ';
    return;
  }
  closeGroupModal();
  if (groupModalMode === 'invite') {
    await openGroupDetails();
    showToast('ส่งคำเชิญแล้ว');
    return;
  }
  closeContacts();
  await loadConversations();
  selectConversation(result.group);
  showToast('สร้างกลุ่มแล้ว');
}

async function openGroupDetails() {
  if (!selectedContact?.isGroup) return;
  groupDetailsError.textContent = '';
  const response = await fetch(`/api/groups/${encodeURIComponent(selectedContact.id)}`);
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'โหลดข้อมูลกลุ่มไม่สำเร็จ');
  const group = result.group;
  activeGroupId = group.id;
  groupDetailsMeta.textContent = `${group.memberCount}/100 สมาชิก${group.isOwner ? ' • คุณเป็นเจ้าของกลุ่ม' : ''}`;
  document.getElementById('groupAddMembersButton').hidden = Boolean(group.ownerId && !group.isOwner);
  document.getElementById('groupLeaveButton').hidden = group.isOwner;
  document.getElementById('groupLeaveButton').textContent = 'ออกจากกลุ่ม';
  groupDetailsMembers.innerHTML = group.members.map((member) => `<div class="person-row">${avatarMarkup(member, 'person-avatar')}<span class="person-copy"><strong>${escapeHtml(member.username)}${member.id === group.ownerId ? ' (เจ้าของ)' : ''}</strong><small>${member.id === currentUser?.id ? 'คุณ' : 'สมาชิกกลุ่ม'}</small></span>${group.isOwner && member.id !== group.ownerId ? `<button class="contact-action remove" data-remove-group-member="${member.id}" title="ลบสมาชิก" aria-label="ลบสมาชิก"><i class="fa-solid fa-user-minus"></i></button>` : ''}</div>`).join('');
  groupDetailsMembers.querySelectorAll('[data-remove-group-member]').forEach((button) => button.addEventListener('click', () => removeGroupMember(button.dataset.removeGroupMember)));
  groupDetailsModal.classList.add('visible');
  groupDetailsModal.setAttribute('aria-hidden', 'false');
}

function closeGroupDetails() {
  groupDetailsModal.classList.remove('visible');
  groupDetailsModal.setAttribute('aria-hidden', 'true');
}

async function removeGroupMember(memberId) {
  const response = await fetch(`/api/groups/${encodeURIComponent(activeGroupId)}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'ลบสมาชิกไม่สำเร็จ');
  await openGroupDetails();
  await loadConversations();
}

async function leaveActiveGroup() {
  if (!selectedContact?.isGroup) return;
  if (selectedContact.ownerId === currentUser?.id) return showToast('เจ้าของกลุ่มต้องโอนสิทธิ์ก่อนออกจากกลุ่ม');
  const response = await fetch(`/api/groups/${encodeURIComponent(selectedContact.id)}/members/${encodeURIComponent(currentUser.id)}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) return showToast(result.error || 'ออกจากกลุ่มไม่สำเร็จ');
  closeGroupDetails();
  goToHome();
  loadConversations().catch(() => {});
  showToast('ออกจากกลุ่มแล้ว');
}

function renderPeople(elementId, people, showAddButton) {
  const container = document.getElementById(elementId);
  if (!people.length) {
    container.innerHTML = `<p class="empty-contacts">${showAddButton ? 'ยังไม่มีรายชื่อแนะนำ' : 'ยังไม่มีเพื่อน'}</p>`;
    return;
  }
  container.innerHTML = people.map((person) => {
    const initials = person.username.slice(0, 2).toUpperCase();
    const online = presenceMap.get(person.id) ?? person.online ?? false;
    const onlineLabel = online ? 'ออนไลน์' : 'ออฟไลน์';
    if (showAddButton) return `<button class="person-row" data-user-id="${person.id}">${avatarMarkup(person, 'person-avatar')}${online ? '<span class="online-dot"></span>' : ''}<span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>${onlineLabel}</small></span><span class="add-person">เพิ่ม</span></button>`;
    return `<div class="person-row" data-user-id="${person.id}">${avatarMarkup(person, 'person-avatar')}${online ? '<span class="online-dot"></span>' : ''}<span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>${onlineLabel}</small></span><button class="contact-action remove" data-action="remove" title="ลบเพื่อน" aria-label="ลบเพื่อน"><i class="fa-solid fa-user-minus"></i></button><button class="contact-action block" data-action="block" title="บล็อกผู้ใช้" aria-label="บล็อกผู้ใช้"><i class="fa-solid fa-ban"></i></button></div>`;
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
  const isBlock = action === 'block';
  showConfirmModal({
    title: isBlock ? 'บล็อกผู้ใช้นี้ไหม?' : 'ลบเพื่อนคนนี้ไหม?',
    description: isBlock
      ? 'เมื่อบล็อกแล้ว คุณจะไม่เห็นข้อความจากผู้ใช้นี้อีก และระบบจะยกเลิกการสนทนากับเพื่อนคนนี้ทันที'
      : 'การลบเพื่อนจะยกเลิกความสัมพันธ์และปิดการสนทนาระหว่างคุณกับเพื่อนคนนี้',
    confirmText: isBlock ? 'บล็อก' : 'ลบเพื่อน',
    onConfirm: async () => {
      const response = await fetch(`/api/contacts/${friendId}${isBlock ? '/block' : ''}`, { method: isBlock ? 'POST' : 'DELETE' });
      if (!response.ok) return showToast('ดำเนินการไม่สำเร็จ');
      if (selectedContact?.id === friendId) {
        selectedContact = null;
        document.getElementById('appShell').classList.remove('mobile-chat-open');
      }
      showToast(isBlock ? 'บล็อกผู้ใช้แล้ว' : 'ลบเพื่อนแล้ว');
      openContacts();
      loadConversations().catch(() => {});
    }
  });
}

function renderFriendNotes(friends) {
  document.getElementById('friendNotes').innerHTML = friends.slice(0, 5).map((friend) => `<button class="note-card" data-note-user="${friend.id}">${avatarMarkup(friend, 'note-avatar')}<strong>${escapeHtml(friend.username)}</strong></button>`).join('');
}

function renderInboxNotes(friends) {
  document.getElementById('inboxFriendNotes').innerHTML = friends.slice(0, 6).map((friend) => `<button class="inbox-note" data-note-user="${friend.id}">${avatarMarkup(friend, 'note-avatar')}<strong>${escapeHtml(friend.username)}</strong></button>`).join('');
  document.querySelectorAll('.inbox-note[data-note-user]').forEach((button) => button.addEventListener('click', () => {
    const friend = friends.find((item) => item.id === button.dataset.noteUser);
    if (friend) selectContact(friend);
  }));
}

function renderFriendRequests(requests) {
  const section = document.getElementById('friendRequestsSection');
  document.getElementById('requestCount').textContent = requests.length ? `(${requests.length})` : '';
  section.hidden = !requests.length;
  document.getElementById('requestsList').innerHTML = requests.map((person) => `<div class="request-row">${avatarMarkup(person, 'person-avatar')}<span class="person-copy"><strong>${escapeHtml(person.username)}</strong><small>ต้องการเป็นเพื่อนกับคุณ</small></span><button class="request-action accept" data-request-id="${person.id}">รับ</button><button class="request-action decline" data-request-id="${person.id}">ปฏิเสธ</button></div>`).join('');
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

function selectConversation(contact) {
  chatSelectionToken += 1;
  selectedContact = contact;
  setAvatarElement(document.getElementById('chatAvatar'), contact, contact.isGroup ? 'G' : contact.username.slice(0, 2).toUpperCase());
  document.getElementById('chatContactName').textContent = contact.isGroup ? contact.name : contact.username;
  updateChatStatusText(contact.isGroup ? `${contact.memberCount || 0} สมาชิก` : (contact.online ? 'ออนไลน์อยู่' : 'ออฟไลน์'), false);
  clearChatArea();
  closeContacts();
  document.getElementById('appShell').classList.add('mobile-chat-open');
  activeRoomId = contact.isGroup ? contact.id : `direct:${[currentUser.id, contact.id].sort().join(':')}`;
  document.getElementById('audioCallButton').disabled = Boolean(contact.isGroup);
  document.getElementById('videoCallButton').disabled = Boolean(contact.isGroup);
  document.getElementById('groupInfoButton').hidden = !contact.isGroup;
  if (!contact.isGroup) {
    fetch(`/api/conversations/${contact.id}/read`, { method: 'POST' }).then(() => {
      if (socket.connected) socket.emit('read-conversation', { peerId: contact.id });
      loadConversations().catch(() => {});
    }).catch(() => {});
  }
  if (socket.connected) socket.emit('join-room', contact.isGroup ? { roomId: contact.id, selectionToken: chatSelectionToken } : { peerId: contact.id, selectionToken: chatSelectionToken });
}

function markActiveConversationRead() {
  if (!socket.connected || !selectedContact || !activeRoomId) return;
  socket.emit('read-conversation', selectedContact.isGroup ? { roomId: activeRoomId } : { peerId: selectedContact.id });
}

function selectContact(contact) { selectConversation(contact); }

function clearChatArea() {
  oldestMessageTimestamp = null;
  replyToMessageId = null;
  chatArea.innerHTML = '<button type="button" class="load-older" id="loadOlderMessages" hidden>โหลดข้อความเก่า</button><div class="date-divider"><span>Today</span></div>';
  document.getElementById('loadOlderMessages').addEventListener('click', loadOlderMessages);
}

function renderConversationList(conversations, groups = []) {
  const container = document.getElementById('conversationList');
  const items = [...groups, ...conversations];
  if (!items.length) {
    container.innerHTML = '<div class="conversation-empty">ยังไม่มีประวัติแชท เลือกเพื่อนจาก Contacts เพื่อเริ่มการสนทนา</div>';
    return;
  }
  container.innerHTML = items.map((person) => `<button class="conversation${selectedContact?.id === person.id ? ' active' : ''}" data-conversation-id="${person.id}" data-conversation-type="${person.isGroup ? 'group' : 'direct'}">${person.isGroup ? avatarMarkup({ username: person.name }, 'avatar violet') : avatarMarkup(person, 'avatar violet') }<span class="conversation-copy"><strong>${escapeHtml(person.isGroup ? person.name : person.username)}</strong><span>${escapeHtml(person.lastText || (person.isGroup ? `${person.memberCount} สมาชิก` : 'เริ่มการสนทนา'))}</span></span>${person.unreadCount ? `<b class="unread-count">${person.unreadCount > 99 ? '99+' : person.unreadCount}</b>` : ''}<time>${person.lastCreatedAt ? formatTime(person.lastCreatedAt) : ''}</time></button>`).join('');
  container.querySelectorAll('[data-conversation-id]').forEach((button) => button.addEventListener('click', async () => {
    if (button.dataset.conversationType === 'group') {
      const group = items.find((item) => item.id === button.dataset.conversationId);
      if (group) selectConversation(group);
      return;
    }
    const response = await fetch('/api/contacts');
    const result = await response.json();
    const contact = result.friends.find((friend) => friend.id === button.dataset.conversationId);
    if (contact) selectConversation(contact);
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
    return `<button class="conversation search-result" data-search-contact="${friendId}">${avatarMarkup({ username: message.senderName, avatarUrl: message.avatarUrl }, 'avatar violet')}<span class="conversation-copy"><strong>${escapeHtml(message.senderName)}</strong><span>${escapeHtml(message.text)}</span></span><time>${formatTime(message.timestamp)}</time></button>`;
  }).join('');
  container.querySelectorAll('[data-search-contact]').forEach((button) => button.addEventListener('click', async () => {
    const response = await fetch('/api/contacts');
    if (!response.ok) return;
    const contact = (await response.json()).friends.find((friend) => friend.id === button.dataset.searchContact);
    if (contact) selectContact(contact);
  }));
}

async function loadConversations() {
  const [conversationResponse, groupResponse] = await Promise.all([fetch('/api/conversations'), fetch('/api/groups')]);
  if (conversationResponse.ok && groupResponse.ok) {
    renderConversationList((await conversationResponse.json()).conversations, (await groupResponse.json()).groups);
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function avatarMarkup(user, className) {
  const initials = (user.username || '?').slice(0, 2).toUpperCase();
  const image = user.avatarUrl ? `<img src="${escapeHtml(user.avatarUrl)}" alt="">` : escapeHtml(initials);
  return `<span class="${className}">${image}</span>`;
}

function setAvatarElement(element, user, fallback) {
  if (!element) return;
  element.textContent = '';
  if (user?.avatarUrl) {
    const image = document.createElement('img');
    image.src = user.avatarUrl;
    image.alt = '';
    element.append(image);
  } else {
    element.textContent = fallback;
  }
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
  setAvatarElement(document.getElementById('railAvatar'), user, initials);
  setAvatarElement(document.getElementById('settingsAvatar'), user, initials);
  document.getElementById('settingsUsername').textContent = user.username;
  document.getElementById('mobileUsername').textContent = user.username;
  setAvatarElement(document.getElementById('mobileNavAvatar'), user, initials);
  setAvatarElement(document.getElementById('noteAvatar'), user, initials);
  setAvatarElement(document.getElementById('inboxNoteAvatar'), user, initials);
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
  if (selectedContact) socket.emit('join-room', selectedContact.isGroup ? { roomId: selectedContact.id, selectionToken: chatSelectionToken } : { peerId: selectedContact.id, selectionToken: chatSelectionToken });
});
socket.on('presence-state', ({ userId, online, status }) => {
  if (!userId) return;
  presenceMap.set(userId, Boolean(online));
  if (selectedContact && selectedContact.id === userId) {
    const label = online ? 'ออนไลน์อยู่' : 'ออฟไลน์';
    document.getElementById('chatContactStatus').textContent = label;
    selectedContact.online = Boolean(online);
    selectedContact.status = status || (online ? 'online' : 'offline');
  }
  loadConversations().catch(() => {});
  if (contactsModal.classList.contains('visible')) openContacts(document.getElementById('contactsSearchInput')?.value || '').catch(() => {});
});
socket.on('connect_error', () => showToast('Please sign in again'));
socket.on('room-joined', ({ participantCount }) => {
  if (selectedContact?.isGroup) {
    updateChatStatusText(`${selectedContact.memberCount || 0} สมาชิก`, false);
    return markActiveConversationRead();
  }
  document.getElementById('chatContactStatus').textContent = participantCount > 1 ? 'ออนไลน์อยู่' : 'ออฟไลน์';
  markActiveConversationRead();
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
socket.on('group-membership-revoked', () => {
  goToHome();
  showToast('คุณถูกนำออกจากกลุ่มแล้ว');
});
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
  updateChatStatusText('กำลังพิมพ์...', true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    socket.emit('typing', { active: false });
    if (selectedContact) {
      updateChatStatusText(selectedContact.online ? 'ออนไลน์อยู่' : 'ออฟไลน์', false);
    }
  }, 900);
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

document.getElementById('emojiButton').addEventListener('click', () => {
  emojiPickerOpen = !emojiPickerOpen;
  document.getElementById('emojiPicker').classList.toggle('visible', emojiPickerOpen);
});

document.querySelectorAll('#emojiPicker [data-emoji]').forEach((button) => {
  button.addEventListener('click', () => {
    const emoji = button.dataset.emoji;
    if (!socket.connected || !selectedContact) return;
    if (messageInput.value.trim()) messageInput.value += ' ';
    messageInput.value += emoji;
    messageInput.focus();
    socket.emit('chat-message', { text: emoji });
    document.getElementById('emojiPicker').classList.remove('visible');
    emojiPickerOpen = false;
  });
});

document.addEventListener('click', (event) => {
  const emojiPicker = document.getElementById('emojiPicker');
  if (!event.target.closest('#emojiButton') && !event.target.closest('#emojiPicker')) {
    emojiPicker.classList.remove('visible');
    emojiPickerOpen = false;
  }
});

socket.on('chat-message', (message) => {
  socket.emit('typing', { active: false });
  renderMessage(message);
  if (selectedContact && message.roomId === activeRoomId) markActiveConversationRead();
  loadConversations().catch(() => {});
  if (!message.isSystem && message.senderId !== currentUser?.id && (!selectedContact || message.roomId !== activeRoomId)) notifyIncomingMessage(message);
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
function updateChatStatusText(text, typing = false) {
  const statusEl = document.getElementById('chatContactStatus');
  const statusText = document.getElementById('chatStatusText');
  if (!statusEl || !statusText) return;
  statusEl.classList.toggle('typing', typing);
  statusText.textContent = text;
}

socket.on('typing', ({ active, username }) => {
  if (!selectedContact) return;
  updateChatStatusText(active ? `${username} กำลังพิมพ์...` : (selectedContact.online ? 'ออนไลน์อยู่' : 'ออฟไลน์'), Boolean(active));
});

socket.on('messages-read', ({ roomId, readerId, readAt, messageIds = [] }) => {
  if (!roomId || !selectedContact || roomId !== activeRoomId) return;
  if (selectedContact.isGroup) {
    document.querySelectorAll('.message-row.mine').forEach((row) => {
      if (!messageIds.includes(row.dataset.messageId)) return;
      const readCount = Number(row.dataset.readCount || 0) + 1;
      row.dataset.readCount = readCount;
      const meta = row.querySelector('.message-meta');
      if (meta) meta.textContent = formatMessageMeta(row.dataset.timestamp, true, '', false, readCount, true);
    });
    return;
  }
  if (readerId !== selectedContact.id) return;
  document.querySelectorAll('.message-row.mine').forEach((row) => {
    const timestamp = row.dataset.timestamp;
    const messageId = row.dataset.messageId;
    if (!timestamp || !messageId) return;
    row.dataset.readAt = readAt;
    const meta = row.querySelector('.message-meta');
    if (meta) meta.textContent = formatMessageMeta(timestamp, true, readAt, false);
  });
  showToast('ข้อความถูกอ่านแล้ว');
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
  if (selectedContact?.isGroup) return showToast('การโทรกลุ่มยังไม่เปิดใช้งาน');
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
  activeCallId = callId;
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
socket.on('call-started', ({ callId }) => { activeCallId = callId; });

socket.on('call-accepted', async ({ senderId, callId }) => {
  activePeerId = senderId;
  activeCallId = callId;
  reconnectAttempts = 0;
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('webrtc-offer', { targetId: senderId, callId, description: peerConnection.localDescription });
});

socket.on('webrtc-offer', async ({ senderId, callId, description }) => {
  activePeerId = senderId;
  activeCallId = callId;
  await setRemoteDescription(description);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('webrtc-answer', { targetId: senderId, callId, description: peerConnection.localDescription });
  updateCallStatus('Connected');
});

socket.on('webrtc-answer', async ({ callId, description }) => {
  if (callId !== activeCallId) return;
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
socket.on('ice-candidate', async ({ callId, candidate }) => {
  if (callId !== activeCallId) return;
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

socket.on('conversation-revoked', () => {
  endCall(false);
  showToast('สิทธิ์เข้าถึงบทสนทนาถูกยกเลิก');
});

function createPeerConnection() {
  pendingIceCandidates = [];
  peerConnection = new RTCPeerConnection(rtcConfiguration);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate && activePeerId && activeCallId) socket.emit('ice-candidate', { targetId: activePeerId, callId: activeCallId, candidate });
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
        socket.emit('webrtc-offer', { targetId: activePeerId, callId: activeCallId, description: peerConnection.localDescription });
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
      longPressGuardUntil = Date.now() + 800;
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

function formatMessageMeta(timestamp, isMine, readAt, deleted, readCount = 0, isGroup = false) {
  const base = formatTime(timestamp);
  if (!isMine || deleted) return base;
  if (isGroup) return `${base} • ${readCount ? `อ่านแล้ว ${readCount} คน` : 'ส่งแล้ว'}`;
  return `${base} • ${readAt ? 'อ่านแล้ว' : 'ส่งแล้ว'}`;
}

function applyReadStatus(row, message) {
  const meta = row.querySelector('.message-meta');
  if (!meta) return;
  const isMine = message.senderId === currentUser?.id;
  if (!isMine) return;
  meta.textContent = formatMessageMeta(message.timestamp, true, message.readAt || message.read_at || row.dataset.readAt, Boolean(message.deleted));
}

function renderMessage(message) {
  const isSystem = Boolean(message.isSystem || message.is_system);
  const isMine = !isSystem && message.senderId === currentUser?.id;
  if (!selectedContact) return;
  const row = document.createElement('div');
  row.className = isSystem ? 'message-row system-message' : `message-row${isMine ? ' mine' : ''}`;
  row.dataset.messageId = message.id;
  row.dataset.timestamp = message.timestamp;
  row.dataset.readAt = message.readAt || message.read_at || '';
  row.dataset.readCount = message.readCount || 0;
  const bubble = document.createElement('div');
  bubble.className = `message-bubble${isSystem ? ' system-bubble' : ''}`;
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
  meta.textContent = formatMessageMeta(message.timestamp, isMine, message.readAt || message.read_at || row.dataset.readAt, Boolean(message.deleted), Number(message.readCount || 0), Boolean(selectedContact?.isGroup));
  row.append(bubble, meta);
  if (message.reactionJson) renderReactions(row, message.reactionJson);
  if (isMine && !message.deleted) {
    const tools = document.createElement('div');
    tools.className = 'message-tools';
    tools.innerHTML = '<button type="button" class="message-more" aria-label="ตัวเลือกข้อความ" title="ตัวเลือกข้อความ"><i class="fa-solid fa-ellipsis"></i></button><div class="message-menu"><button type="button" data-message-action="reply"><i class="fa-solid fa-reply"></i> ตอบกลับ</button><button type="button" data-message-action="react"><i class="fa-solid fa-heart"></i> ถูกใจ</button><button type="button" data-message-action="edit"><i class="fa-solid fa-pen"></i> แก้ไข</button><button type="button" class="delete-message" data-message-action="delete"><i class="fa-solid fa-trash"></i> ลบ</button></div>';
    tools.querySelector('.message-more').addEventListener('click', (event) => {
      event.stopPropagation();
      document.querySelectorAll('.message-tools.open').forEach((item) => { if (item !== tools) item.classList.remove('open'); });
      tools.classList.toggle('open');
    });
    tools.querySelector('[data-message-action="reply"]').addEventListener('click', () => { replyToMessageId = message.id; messageInput.focus(); showToast('กำลังตอบกลับข้อความ'); tools.classList.remove('open'); });
    tools.querySelector('[data-message-action="react"]').addEventListener('click', () => { socket.emit('react-message', { messageId: message.id, emoji: '❤️' }); tools.classList.remove('open'); });
    tools.querySelector('[data-message-action="edit"]').addEventListener('click', () => {
      openEditModal('message', { messageId: message.id, text: message.text });
      tools.classList.remove('open');
    });
    tools.querySelector('[data-message-action="delete"]').addEventListener('click', () => {
      openDeleteConfirm(message.id);
      tools.classList.remove('open');
    });
    attachLongPress(bubble, () => tools.classList.add('open'));
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
  showConfirmModal({
    title: 'ยกเลิกข้อความนี้ไหม?',
    description: 'ข้อความนี้จะถูกลบออกจากการสนทนาสำหรับทุกคน แต่อาจมีคนเห็นไปแล้ว',
    confirmText: 'ยืนยัน',
    onConfirm: () => {
      if (socket.connected) socket.emit('delete-message', { messageId });
    }
  });
}

function closeDeleteConfirm() {
  closeConfirmModal();
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
function setCallQualityState(level, labelText) {
  const qualityEl = document.getElementById('callQuality');
  const label = document.getElementById('callQualityLabel');
  if (!qualityEl || !label) return;
  qualityEl.className = `call-quality ${level}`;
  label.textContent = labelText || 'เครือข่ายคงที่';
}

function updateCallStatus(status) {
  callStatus.textContent = status;
  voiceStatus.textContent = status;
  if (!peerConnection) {
    setCallQualityState('good', 'เครือข่ายคงที่');
    return;
  }
  const connectionState = peerConnection.iceConnectionState || peerConnection.connectionState || 'connected';
  if (['connected', 'completed'].includes(connectionState)) setCallQualityState('good', 'เครือข่ายคงที่');
  else if (['checking', 'new'].includes(connectionState)) setCallQualityState('fair', 'กำลังตรวจสอบเครือข่าย');
  else if (['failed', 'disconnected'].includes(connectionState)) setCallQualityState('disconnected', 'การเชื่อมต่อขาดหาย');
  else setCallQualityState('weak', 'เครือข่ายอ่อน');
}
function showLocalMedia() { localVideo.srcObject = localStream; localVideo.classList.toggle('hidden', activeCallMode !== 'video'); remoteVideo.classList.toggle('hidden', activeCallMode !== 'video'); voicePlaceholder.classList.toggle('hidden', activeCallMode === 'video'); }

function endCall(notifyPeer) {
  if (notifyPeer && socket.connected) socket.emit('end-call', { callId: activeCallId });
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  if (screenStream) screenStream.getTracks().forEach((track) => track.stop());
  peerConnection = null; localStream = null; activePeerId = null; activeCallId = null; isCaller = false; pendingIceCandidates = [];
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
