# Auto Image Flow - Chrome Extension

Chrome extension สำหรับการทำงานอัตโนมัติบน Google Labs Flow ที่สามารถทำงานใน background tab ได้

## ✨ Features

- 🔄 **Background Tab Automation** - ทำงานต่อได้แม้เปลี่ยน tab
- 📥 **Auto Download Queue** - จัดการการดาวน์โหลดหลายไฟล์
- 🎯 **Smart Click Detection** - หาปุ่มดาวน์โหลดอัตโนมัติ
- 🛡️ **Visibility Spoofing** - หลอก browser ให้คิดว่า tab ยัง active
- ⚡ **Service Worker Keep-Alive** - รักษา extension ให้ทำงานต่อเนื่อง

## 🚀 Installation

1. ดาวน์โหลดโค้ดจาก GitHub
2. เปิด Chrome → `chrome://extensions`
3. เปิด "Developer mode"
4. กด "Load unpacked" → เลือกโฟลเดอร์ extension
5. ไปที่ Google Labs Flow และเริ่มใช้งาน

## 📖 How to Use

### การใช้งานพื้นฐาน
1. เปิด Google Labs Flow project
2. Extension จะแสดง panel ทางขวา
3. เพิ่ม prompt ลงใน queue
4. กด "Start queue"
5. **เปลี่ยนไป tab อื่นได้เลย** - extension จะทำงานต่อใน background

### การทดสอบ Background Automation
1. เปิด `test-page.html` ใน browser
2. กด "Start Queue Test"
3. เปลี่ยนไป tab อื่นทันที
4. รอ 30-60 วินาที แล้วกลับมาดู log
5. ถ้าเห็น "✅ Clicked download button (visibility: hidden)" แสดงว่าทำงานได้

## 🔧 Technical Details

### Architecture
- **Manifest V3** - ใช้ Service Worker แทน background page
- **Offscreen API** - รักษา service worker ให้ทำงานต่อเนื่อง
- **Chrome Downloads API** - จัดการการดาวน์โหลดผ่าน background
- **Content Script Injection** - แก้ไข page behavior

### Background Tab Techniques
1. **Visibility Spoofing** - Override `document.visibilityState`
2. **Event Blocking** - Block `visibilitychange` listeners
3. **RAF Shimming** - Replace `requestAnimationFrame` with `setTimeout`
4. **Intersection Observer Spoofing** - Force elements to appear "visible"
5. **Chrome Alarms** - Use for reliable timing in background

### Download Strategies
1. **URL Extraction** - หา download URL จาก DOM
2. **Background Download API** - ใช้ `chrome.downloads.download()`
3. **Multiple Click Fallbacks** - หลายวิธีในการ click ปุ่ม
4. **Queue Management** - จัดการ concurrent downloads

## 🛠️ Development

### File Structure
```
├── manifest.json              # Extension configuration
├── background.js              # Service worker + download queue
├── content.js                 # Main content script + visibility spoofing
├── flow-page-actions.js       # Page automation functions
├── queue-panel.js             # Queue management UI
├── offscreen.js               # Keep-alive mechanism
├── offscreen.html             # Offscreen document
├── content.css                # UI styling
├── popup.html/js              # Extension popup
└── test-background-automation.js  # Testing utilities
```

### Key Functions
- `clickDownload()` - Smart download button detection
- `fillPromptAndSubmit()` - Auto form filling
- `waitForGenerationToFinish()` - Progress monitoring
- `injectVisibilitySpoofer()` - Background tab spoofing

## 🐛 Troubleshooting

### Common Issues
1. **CSP Violations** - ใช้ direct API calls แทน script injection
2. **Audio Autoplay Blocked** - Expected behavior, ไม่กระทบการทำงาน
3. **Service Worker Termination** - ใช้ offscreen document + alarms
4. **Download Failures** - มี fallback หลายระดับ

### Debug Tips
- เปิด DevTools → Console เพื่อดู logs
- ตรวจสอบ `chrome://extensions` สำหรับ errors
- ใช้ test page เพื่อทดสอบ background functionality

## 📝 License

MIT License - ใช้งานและแก้ไขได้อย่างอิสระ

## 🤝 Contributing

1. Fork repository
2. สร้าง feature branch
3. Commit changes
4. Push และสร้าง Pull Request

---

**หมายเหตุ:** Extension นี้ออกแบบมาสำหรับ Google Labs Flow โดยเฉพาะ แต่เทคนิคที่ใช้สามารถนำไปประยุกต์กับเว็บไซต์อื่นได้