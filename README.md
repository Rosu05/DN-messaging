# Direct Networking Lab

โครงงานนี้เป็น Full-stack Web Application สำหรับหัวข้อที่ 1 Instant Messaging Protocol ร่วมกับหัวข้อที่ 7 Cloud Deployment ของวิชา Data Networking

## ความสามารถของระบบ

- ส่งข้อความแบบ real-time ระหว่าง browser หลายเครื่องผ่าน Socket.io ซึ่งทำงานบน TCP และ WebSocket upgrade
- Audio call และ Video call แบบ peer-to-peer ด้วย WebRTC โดยใช้ Google STUN Server `stun:stun.l.google.com:19302`
- Signaling Server สำหรับแลกเปลี่ยน SDP Offer, SDP Answer และ ICE Candidate ผ่าน Socket.io
- ปุ่ม Mute microphone, Turn off camera และ End call พร้อมหน้าต่าง call แบบ responsive
- Express static server, health check และ Docker image สำหรับ cloud deployment
- Turso database schema สำหรับ users, rooms, room members และ message history
- Register/login ด้วย bcrypt password hash และ httpOnly authentication cookie
- Unread count, read status และ browser/audio notification สำหรับข้อความใหม่
- File upload สูงสุด 10 MB ต่อไฟล์ พร้อมลิงก์ไฟล์ในข้อความ
- Typing indicator, แก้ไข/ลบข้อความ และ call history API
- Incoming call modal, ICE restart retry และระบบ block/unblock ผู้ใช้
- Rate limiting สำหรับ register/login และรองรับ TURN server ผ่าน environment variables

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

รัน smoke tests ก่อนส่งงานหรือ deploy:

```powershell
npm test
```

เปิด `http://localhost:3000` สอง browser windows หรือสองเครื่องใน network เดียวกันเพื่อทดสอบ chat และ call หากเปิดจากเครื่องอื่น ให้ใช้ IP ของเครื่องที่รัน server แทน `localhost`

ตรวจสอบ server:

```powershell
Invoke-WebRequest http://localhost:3000/health
```

## Environment Variables สำหรับ Turso

ตั้งค่าตัวแปรต่อไปนี้ใน Render Web Service เพื่อเปิดใช้งานการสร้าง schema ฐานข้อมูลอัตโนมัติ:

```text
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
SESSION_SECRET=สุ่มค่าลับอย่างน้อย 32 ตัวอักษร
TURN_SERVER_URL=turn:your-turn-server:3478,turns:your-turn-server:5349
TURN_USERNAME=ชื่อผู้ใช้ TURN
TURN_CREDENTIAL=รหัสผ่าน TURN
```

เมื่อเซิร์ฟเวอร์เริ่มทำงาน จะสร้างตาราง `users`, `rooms`, `room_members` และ `messages` หากยังไม่มีตารางเหล่านี้ โดยไม่ลบข้อมูลเดิม

ไฟล์ที่อัปโหลดจะถูกเก็บในโฟลเดอร์ `uploads/` ของ container ดังนั้น production ที่ต้องการเก็บไฟล์ถาวรควรใช้ object storage หรือ mounted volume

ระบบจะจำกัด signaling ของ WebRTC ให้ส่งต่อได้เฉพาะ socket ที่อยู่ในห้องเดียวกัน และจำกัด login/register ด้วย rate limit แต่การ deploy หลาย instance ยังต้องใช้ Redis adapter เพื่อให้ Socket.io กระจาย event ได้ครบทุก instance

## Cloud Deployment ด้วย Docker

```powershell
docker compose up --build -d
docker compose ps
```

ก่อนรันบน production ให้กำหนด `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` และ `SESSION_SECRET` ใน environment ของ Docker Compose โดย `uploads` จะถูกเก็บใน named volume เพื่อไม่หายเมื่อ container ถูกสร้างใหม่

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
