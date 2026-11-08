# ร้านข้าวหมูแดง: staging, migration และ rollback

สถานะ: เอกสารนี้ใช้สำหรับ staging เท่านั้น ห้าม deploy หรือ push จนกว่าเจ้าของร้านอนุมัติเป็นลายลักษณ์อักษร

## ขอบเขตระบบ

- Worker: `moo-daeng-pos`; staging: `moo-daeng-pos-staging`
- Cloudflare account: ร้านใหม่เท่านั้น (`e9992412fcfd4b91eb138afac9be9abf` ใน `wrangler.jsonc`)
- Durable Object: SQLite ของ Worker แต่ละ environment แยกกัน ไม่มีการคัดลอกข้อมูลหรือ binding จากร้านเดิม
- โต๊ะ: `T1`–`T14`; รับกลับบ้าน: `TA1`–`TA2`
- งานพิมพ์: `kitchen` = ใบสั่ง/ใบยกเลิก, `counter` = ใบเสร็จ; `bar` และ `qr` ไม่เปิดใช้

## สิทธิ์ API

| กลุ่ม | ใช้งานได้ |
| --- | --- |
| ลูกค้า | อ่าน/สั่งเฉพาะ session โต๊ะตัวเอง |
| พนักงาน | สั่งเพิ่ม, สถานะโต๊ะ, รายงาน, พิมพ์ซ้ำ, void ออเดอร์ |
| เจ้าของ | สิทธิ์พนักงาน + เมนู, settings, Bridge credentials, ยกเลิกบิล |
| Android Bridge | รับ/claim/ack เฉพาะคิวสถานีที่ผูกกับ credential |
| Bill reader | อ่านรายงานบิลเท่านั้น |

ทุก route ที่ไม่มีรายการใน `src/auth.js` ถูกปฏิเสธโดยค่าเริ่มต้น

## ก่อน deploy staging

1. ติดตั้ง secret ผ่าน `wrangler secret put` เท่านั้น: `SESSION_SECRET`, `OWNER_PASSWORD`, `STAFF_PASSWORD`, `ADMIN_TOKEN`, `BILL_READER_TOKEN` และ `STAFF_ID` (ชื่อพนักงานที่จะแสดงใน audit)
2. ห้ามวาง secret, device token หรือ IP จริงใน Git, ticket หรือ log
3. ตรวจ account ก่อนทุก deploy:

   ```sh
   npx wrangler whoami
   ```

4. export menu/settings ก่อนเริ่มผ่าน `GET /api/_admin/export` โดยใช้ `ADMIN_TOKEN` แล้วเก็บไฟล์นอก repo
5. ตั้งเมนูจริงและราคาใน Admin ก่อนเปิดรับออเดอร์ ระบบเริ่มด้วยเมนูว่างเพื่อไม่สร้างข้อมูลธุรกิจปลอม
6. สร้าง Bridge credential แยกสองชุด: `station: kitchen` และ `station: counter`; เก็บ APK เดิมไว้ก่อนเปลี่ยน endpoint

## Migration / rollback

- การเปลี่ยน state หลักใช้ `SqliteStore.batchSet()` ซึ่งเป็น SQLite transaction: order+งานครัว, bill+close session+receipt และ cancellation+queue จะ commit หรือ rollback พร้อมกัน
- ก่อนเปลี่ยน schema ให้ export จาก staging; migration Durable Object ต้องเพิ่ม tag ใหม่ใน `wrangler.jsonc` และทดสอบ restore ใน staging
- Rollback ที่ปลอดภัยคือ deploy Worker เวอร์ชันก่อนหน้าไป staging แล้ว import backup เดิม ห้ามใช้ data/binding ของร้านเก่า
- หาก Bridge ใหม่มีปัญหา ให้หยุด credential ใหม่, เปิด APK เวอร์ชันก่อนหน้า และใช้ใบสั่งมือจนคิวพิมพ์ได้รับการตรวจสอบ

## Quota model: Cloudflare Free (ประมาณการ)

สมมติวันเปิด 9 ชม. 40 นาที, Bridge 2 สถานี poll ทุก 30 วินาทีเมื่อว่าง, หน้าพนักงาน 1 จอทุก 30 วินาที, ครัว 1 จอทุก 15 วินาที, ลูกค้า 16 session, 300 ออเดอร์/วัน; วันหนักคูณสอง

| แหล่ง | วันปกติ request โดยประมาณ | วันหนัก |
| --- | ---: | ---: |
| Bridge 2 สถานี | 2,320 | 4,640 |
| หน้าพนักงาน + ครัว | 2,900 | 5,800 |
| ลูกค้า/สั่ง/ชำระ/รายงาน | 1,500 | 3,000 |
| รวม | 6,720 | 13,440 |

วันหนักคิดเป็น 13.4% ของ 100,000 DO requests/วัน และต่ำกว่า 50% ของเพดาน request/rows write หาก Bridge ไม่ poll ถี่กว่ากำหนด งานอ่าน/เขียนจริงต้องวัดจาก staging ก่อนเปิดร้าน; หาก quota หรือ Bridge เตือนผิดปกติให้กลับไปใช้ใบสั่งและใบเสร็จมือทันที

## การซ้อมก่อนเปิด

1. ลูกค้า `T3` สั่ง -> kitchen Bridge รับ/print/ack
2. พนักงานเพิ่มรายการ -> ยืนยัน `staffId` ในออเดอร์
3. void หลังใบครัวพิมพ์ -> kitchen Bridge ได้ ticket `void`
4. ชำระ -> bill status `paid` -> counter Bridge ได้ receipt
5. ยกเลิกบิลโดยเจ้าของ -> ยอดรายงานไม่รวมบิลนั้น
6. ปิด Bridge 5 นาที, ถอด LAN เครื่องครัว, restart Android และยืนยัน retry/lease ตามจริง

## หมายเหตุหลังรีวิวรอบที่ 2 (ก่อนเปิดร้าน)

- **โต๊ะกลับบ้าน:** ทุกออเดอร์ `TA1`/`TA2` ถูกเก็บเป็นป้ายเฉพาะ เช่น `TA1-K7Q` และคิดเงินแยกบิลต่อออเดอร์ ลูกค้าสองคนไม่ปนกัน (พนักงานเพิ่มรายการเข้าออเดอร์กลับบ้านเดิมไม่ได้ ต้องเปิดออเดอร์ใหม่)
- **Rate limit:** ออเดอร์ลูกค้า 3 ครั้ง/นาที/โต๊ะ (`ORDER_RATE_PER_MIN`) และ 30 ครั้ง/นาที/ไอพี (`ORDER_RATE_PER_MIN_PER_CLIENT`) เพราะลูกค้าทั้งร้านใช้ Wi-Fi เดียวกัน การส่งซ้ำด้วย idempotency key เดิมไม่นับ
- **แผงสถานะโต๊ะ** แสดงโต๊ะตาม `tableIds` (T1–T14) ส่วนโต๊ะกลับบ้านขึ้นเฉพาะตอนมีออเดอร์
- **พิมพ์ซ้ำ:** งานพิมพ์ที่กลับเข้าคิวหลังเริ่มพิมพ์แล้ว (lease หมดอายุ, release หลัง printing, กด retry) จะมี `reprint: true` และ `reprintLabel`. **แอป Bridge ต้องพิมพ์ `reprintLabel` บนกระดาษ** (ยังไม่ได้ตรวจเพราะไม่มี source ของ Bridge)
- **ชื่อพนักงาน:** ทุกคนล็อกอินด้วยรหัสเดียว ชื่อบนบิลจึงเป็น `STAFF_ID` ค่าเดียว (ไม่ใช่ secret ใส่เป็น var ได้) ถ้าต้องแยกรายคนต้องเพิ่ม PIN ต่อคน
- **ยังไม่ได้ตรวจ:** แอป Android Bridge, `jinor-bill-summary`, staging จริง, โควตาที่วัดได้จริง, `wrangler whoami`, backup/rollback
