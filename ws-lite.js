// 부품 없이 만든 작은 웹소켓 서버 (RFC 6455, 텍스트 메시지만)
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.open = true; this.parts = [];
    this.onmessage = null; this.onclose = null; this.alive = true;
    sock.on('data', d => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
    sock.setNoDelay(true);
  }
  _closed() { if (!this.open) return; this.open = false; if (this.onclose) this.onclose(); }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 2 * 1024 * 1024) { this.close(); return; }
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1024 * 1024) { this.close(); return; }
      const mOff = off; if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) { const m = b.subarray(mOff, mOff + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this._send(0x8, Buffer.alloc(0)); this.sock.end(); this._closed(); return; }
      if (op === 0x9) { this._send(0xA, payload); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x0 || op === 0x2) {
        this.parts.push(payload);
        if (fin) { const msg = Buffer.concat(this.parts).toString('utf8'); this.parts = []; this.alive = true; if (this.onmessage) { try { this.onmessage(msg); } catch (e) { console.error('ws handler', e); } } }
      }
    }
  }
  _send(op, payload) {
    if (!this.open) return;
    const n = payload.length; let head;
    if (n < 126) { head = Buffer.from([0x80 | op, n]); }
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    try { this.sock.write(Buffer.concat([head, payload])); } catch (e) { this._closed(); }
  }
  send(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
  ping() { this._send(0x9, Buffer.alloc(0)); }
  close() { if (!this.open) return; this._send(0x8, Buffer.alloc(0)); try { this.sock.end(); } catch (e) {} this._closed(); }
}

// http 서버의 upgrade 요청을 받아 웹소켓 연결로 바꾼다
function attach(server, path, onConn) {
  server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
    const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
    const c = new Conn(sock); onConn(c, url, req);
  });
}
module.exports = { attach, Conn };
