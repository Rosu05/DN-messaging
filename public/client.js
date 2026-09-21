const socket = io();
const roomId = 'networking-demo';
const username = `Student-${Math.floor(Math.random() * 900 + 100)}`;
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

let peerConnection = null;
let localStream = null;
let activePeerId = null;
let activeCallMode = 'video';
let isCaller = false;
let toastTimer = null;

socket.on('connect', () => socket.emit('join-room', { roomId, username }));
socket.on('room-joined', ({ participantCount }) => {
  if (participantCount > 1) showToast('Connected to the networking room');
});
socket.on('peer-joined', ({ username: peerName }) => showToast(`${peerName} is online`));
socket.on('peer-left', () => { if (callModal.classList.contains('visible')) endCall(false); });

messageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket.connected) return;
  socket.emit('chat-message', { roomId, text });
  messageInput.value = '';
  messageInput.focus();
});

document.getElementById('heartButton').addEventListener('click', () => {
  socket.emit('chat-message', { roomId, text: '❤️' });
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
    socket.emit('call-user', { roomId, mode });
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
    socket.emit('end-call', { roomId });
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
  const isMine = message.senderId === socket.id;
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
}

function formatTime(timestamp) { return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp)); }
function openCallModal(title, status) { callTitle.textContent = 'Alex Morgan'; callStatus.textContent = title; voiceStatus.textContent = status; callModal.classList.add('visible'); callModal.setAttribute('aria-hidden', 'false'); }
function updateCallStatus(status) { callStatus.textContent = status; voiceStatus.textContent = status; }
function showLocalMedia() { localVideo.srcObject = localStream; localVideo.classList.toggle('hidden', activeCallMode !== 'video'); remoteVideo.classList.toggle('hidden', activeCallMode !== 'video'); voicePlaceholder.classList.toggle('hidden', activeCallMode === 'video'); }

function endCall(notifyPeer) {
  if (notifyPeer && socket.connected) socket.emit('end-call', { roomId });
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
