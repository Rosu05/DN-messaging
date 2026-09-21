# Direct Networking Lab

โครงงานนี้เป็น Full-stack Web Application สำหรับหัวข้อที่ 1 Instant Messaging Protocol ร่วมกับหัวข้อที่ 7 Cloud Deployment ของวิชา Data Networking

## ความสามารถของระบบ

- ส่งข้อความแบบ real-time ระหว่าง browser หลายเครื่องผ่าน Socket.io ซึ่งทำงานบน TCP และ WebSocket upgrade
- Audio call และ Video call แบบ peer-to-peer ด้วย WebRTC โดยใช้ Google STUN Server `stun:stun.l.google.com:19302`
- Signaling Server สำหรับแลกเปลี่ยน SDP Offer, SDP Answer และ ICE Candidate ผ่าน Socket.io
- ปุ่ม Mute microphone, Turn off camera และ End call พร้อมหน้าต่าง call แบบ responsive
- Express static server, health check และ Docker image สำหรับ cloud deployment

## โครงสร้างและเทคโนโลยี

```text
server.js                 Express + Socket.io signaling server
public/index.html         Chat and call interface
public/style.css          Responsive Instagram DM-inspired UI
public/client.js          Socket.io, WebRTC, media controls
Dockerfile                Production container image
docker-compose.yml        Local/cloud-compatible container orchestration
```

เส้นทางข้อมูลของระบบมี 2 แบบ: ข้อความและ signaling เดินทางผ่าน TCP connection ของ Socket.io ไปยัง Node.js server ส่วน audio/video หลังจาก handshake สำเร็จจะเดินทางโดยตรงระหว่าง peer ผ่าน WebRTC ซึ่งใช้ ICE/STUN เพื่อค้นหา network path และพยายามส่ง media ผ่าน UDP เพื่อลด latency

## วิธีรันสำหรับสาธิต

ต้องใช้ Node.js 18 ขึ้นไป

```powershell
npm install
npm start
```

เปิด `http://localhost:3000` สอง browser windows หรือสองเครื่องใน network เดียวกันเพื่อทดสอบ chat และ call หากเปิดจากเครื่องอื่น ให้ใช้ IP ของเครื่องที่รัน server แทน `localhost`

ตรวจสอบ server:

```powershell
Invoke-WebRequest http://localhost:3000/health
```

## Cloud Deployment ด้วย Docker

```powershell
docker compose up --build -d
docker compose ps
```

นำ image นี้ไปใช้บน Cloud VM หรือ container platform ที่เปิด port `3000` ได้ โดยตั้งค่า `PORT` ตาม port ที่ cloud provider จัดสรร หากต้องการใช้กล้องและไมโครโฟนบน production browser ต้อง deploy ผ่าน HTTPS

## ขั้นตอนสาธิตระบบ

1. เปิดระบบด้วย browser สองหน้าต่างและตรวจสอบว่า status เป็น Active now
2. ส่งข้อความจากทั้งสองฝั่งเพื่อแสดง sender/receiver และ timestamp
3. กด Video Call ฝั่งหนึ่ง แล้วกด Accept อีกฝั่งเพื่อสาธิต `call-user`, `call-accepted`, SDP และ ICE
4. แสดง remote video, local picture-in-picture, mute, camera toggle และ end call
5. เปิด `/health` และแสดง container status เพื่ออธิบาย Cloud Deployment

## เนื้อหาสำหรับ Project Proposal

### บทที่ 1 บทนำ

ปัญหาของการสื่อสารแบบเดิมคือผู้ใช้ต้องการการส่งข้อความที่ทันที และการสื่อสารเสียง/ภาพที่มี latency ต่ำ ระบบนี้จึงสาธิตการเลือก protocol ให้เหมาะกับข้อมูลแต่ละชนิด โดยใช้ TCP/WebSocket กับข้อความและ signaling และใช้ WebRTC/UDP กับ media

### บทที่ 2 ทฤษฎีและเทคโนโลยี

อธิบาย TCP, WebSocket, Socket.io, HTTP, SDP, ICE, STUN, WebRTC, Express และ Docker รวมถึงความแตกต่างระหว่าง reliable ordered data ของ TCP กับ real-time media transport ของ WebRTC

### บทที่ 3 วิธีการพัฒนาระบบ

ระบบแบ่งเป็น browser clients, Node.js signaling server และ cloud container ผู้ใช้ join room ผ่าน Socket.io จากนั้น chat ใช้ event `chat-message` ส่วน call ใช้ลำดับ `call-user` -> `call-accepted` -> `webrtc-offer` -> `webrtc-answer` -> `ice-candidate` ก่อนเริ่มส่ง media ระหว่าง peer

### บทที่ 4 ผลการพัฒนาระบบ

ผลลัพธ์คือหน้า chat ที่ส่งข้อความ real-time ได้ ระบบ audio/video call พร้อม control พื้นฐาน และ Docker image ที่มี health check สามารถนำไป deploy บน Cloud VM หรือ container service ได้

### บทที่ 5 สรุปและข้อเสนอแนะ

ระบบตอบโจทย์การทดลอง Instant Messaging Protocol และ Cloud Deployment ในขอบเขตที่กำหนด การพัฒนาต่อสามารถเพิ่ม authentication, message database, TURN server สำหรับ network ที่มี firewall และ horizontal scaling ด้วย Redis adapter

## คำถามที่ควรเตรียมตอบ

- ทำไม chat ใช้ TCP/WebSocket แต่ media ใช้ WebRTC/UDP: chat ต้องการความถูกต้องและลำดับ ส่วน media ให้ความสำคัญกับ latency และยอมรับการสูญเสีย packet บางส่วนได้
- Signaling server ส่ง video หรือไม่: ไม่ส่ง video; ส่งเฉพาะ SDP และ ICE metadata เพื่อให้ peer ค้นหาและตั้งค่า connection
- STUN มีหน้าที่อะไร: ช่วยให้ peer ทราบ public address และ candidate สำหรับ NAT traversal แต่ไม่ใช่ media relay
- ถ้า STUN เชื่อมต่อไม่ได้ทำอย่างไร: เพิ่ม TURN server และกำหนด `iceServers` เพิ่มเติม
- Cloud deployment ต้องระวังอะไร: เปิด port, ใช้ HTTPS สำหรับ media permission, ตั้ง health check และจัดการ scale/state ของ signaling server
