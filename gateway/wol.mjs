import dgram from 'node:dgram';
import { isIPv4 } from 'node:net';

/** Return a canonical unicast hardware address; never accept a network job's MAC. */
export function validateMac(value) {
  if (typeof value !== 'string') throw new TypeError('PC_MAC must be a MAC address.');
  const mac = value.trim();
  const separated = /^(?:[a-f\d]{2}:){5}[a-f\d]{2}$|^(?:[a-f\d]{2}-){5}[a-f\d]{2}$/i;
  if (!/^[a-f\d]{12}$/i.test(mac) && !separated.test(mac)) {
    throw new TypeError('PC_MAC must contain six hexadecimal octets.');
  }
  const compact = mac.replace(/[:-]/g, '').toLowerCase();
  if (compact === '000000000000' || (Number.parseInt(compact.slice(0, 2), 16) & 1)) {
    throw new TypeError('PC_MAC must be a nonzero unicast address.');
  }
  return compact.match(/.{2}/g).join(':');
}

export function validateAddress(value) {
  if (typeof value !== 'string' || !isIPv4(value)) {
    throw new TypeError('WOL_BROADCAST must be an IPv4 address, not a hostname.');
  }
  const first = Number(value.split('.')[0]);
  if (first === 0 || (first >= 224 && first <= 239)) {
    throw new TypeError('WOL_BROADCAST cannot be unspecified or multicast.');
  }
  return value;
}

export function validatePort(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError('WOL_PORT must be an integer between 1 and 65535.');
  }
  return value;
}

export function createMagicPacket(mac) {
  const hardwareAddress = Buffer.from(validateMac(mac).replaceAll(':', ''), 'hex');
  const packet = Buffer.alloc(102, 0xff);
  for (let repeat = 0; repeat < 16; repeat++) hardwareAddress.copy(packet, 6 + repeat * 6);
  return packet;
}

/** A successful send means only that UDP accepted the packet, not that the PC woke. */
export async function sendWake({ mac, address = '255.255.255.255', port = 9 }) {
  const packet = createMagicPacket(mac);
  address = validateAddress(address);
  port = validatePort(port);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { socket.close(); } catch { /* A bind failure can leave the socket unbound. */ }
      if (error) reject(error);
      else resolve({ bytes: packet.length, address, port });
    };
    const timeout = setTimeout(() => finish(new Error('Wake packet send timed out.')), 3000);
    socket.once('error', finish);
    socket.bind(0, '0.0.0.0', () => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, port, address, finish);
      } catch (error) { finish(error); }
    });
  });
}
