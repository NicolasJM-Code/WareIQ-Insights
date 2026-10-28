// Build an explicitly allowlisted, credential-free download using Node built-ins.
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const files = [
  ["server.mjs", read("connectors/openvpn/server.mjs")],
  ["policy.mjs", read("connectors/openvpn/policy.mjs")],
  ["README.md", read("docs/openvpn-connector.md")
    .replaceAll("connectors/openvpn/server.mjs", "server.mjs")
    .replaceAll("docs/wms-mysql.md", "MYSQL-SETUP.md")],
  ["MYSQL-SETUP.md", read("docs/wms-mysql.md").replaceAll("(openvpn-connector.md)", "(README.md)")],
];

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Small deterministic ZIP (stored entries), avoiding platform gzip content decoding.
const local = [], central = [];
let offset = 0;
for (const [name, text] of files) {
  const filename = Buffer.from(`wareiq-openvpn-connector/${name}`);
  const data = Buffer.from(text), crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(33, 12); // 1980-01-01, a valid deterministic ZIP date.
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  local.push(header, filename, data);
  const index = Buffer.alloc(46);
  index.writeUInt32LE(0x02014b50, 0);
  index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(33, 14);
  index.writeUInt32LE(crc, 16);
  index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24);
  index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42);
  central.push(index, filename);
  offset += header.length + filename.length + data.length;
}
const directoryIndex = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directoryIndex.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, directoryIndex, end]);
const directory = new URL("artifacts/wareiq/public/downloads/", root);
mkdirSync(directory, { recursive: true });
rmSync(new URL("wareiq-openvpn-connector.tar.gz", directory), { force: true });
writeFileSync(new URL("wareiq-openvpn-connector.zip", directory), archive);
process.stdout.write("Prepared WareIQ OpenVPN connector download (source and setup guides only).\n");
