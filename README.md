# POS Model (แม่แบบระบบสั่งอาหารและ POS สำหรับร้านอาหาร)

แม่แบบระบบสั่งอาหารผ่าน QR และ POS บน Cloudflare Workers + Durable Objects (SQLite)
ชื่อร้าน เบอร์โทร โลโก้ เมนู และเวลาเปิด-ปิด ตั้งในหน้าแอดมินหลัง deploy ไม่ได้ฝังในโค้ด

## มีอะไรบ้าง

- หน้าสั่งอาหารของลูกค้า และหน้าแอดมิน
- โต๊ะ เมนู ใบเสร็จ จอครัว เครื่องพิมพ์ ลิ้นชักเก็บเงิน และประวัติบิล
- Cloudflare Worker + Durable Object
- เทสต์อัตโนมัติ (`npm test`) และเอกสาร deploy

## เริ่มสำหรับร้านใหม่

1. อ่าน `NEW-SHOP-SETUP.md` และทำตามรายการตรวจสอบ
2. คัดลอก `wrangler.template.jsonc` เป็น `wrangler.jsonc` แล้วแทนค่า `<...>` (ห้ามใช้ค่าของร้านอื่น)
3. ตั้ง secret ด้วย `wrangler secret put` เท่านั้น ห้ามใส่รหัส/token ใน Git หรือไฟล์ `.dev.vars`
4. ทดสอบบน staging ก่อน deploy จริง
5. ก่อนส่งโค้ดให้ร้านใหม่ รัน `node scripts/check-new-shop.mjs --all` ต้องไม่พบข้อมูลร้านเดิม
6. เปลี่ยนสีแบรนด์ได้ที่ตัวแปร `--brand-*` ใน `public/admin-theme.css`

ที่เก็บนี้ตั้งใจไม่รวม dependency ในเครื่อง สถานะของ Wrangler และไฟล์ secret
