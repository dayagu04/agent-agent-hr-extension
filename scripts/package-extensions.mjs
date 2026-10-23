import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { artifactFiles, checkFiles, products } from './check-extension-artifacts.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const selected = process.argv.slice(2)
if (selected.some(name => !Object.hasOwn(products, name))) throw new Error(`Unknown extension: ${selected.join(', ')}`)

// STORE archives are understood by Chrome, Edge, GitHub and standard unzip.
// No release-time dependency download or platform-specific ZIP executable.
function archive(files) {
  const entries = []
  const directory = []
  let offset = 0
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const name = Buffer.from(path)
    const crc = crc32(content)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(0x21, 12) // deterministic 1980-01-01 DOS date
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(content.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(name.length, 26)
    entries.push(header, name, content)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)
    offset += header.length + name.length + content.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...entries, central, end])
}

// Verify the bytes about to be uploaded, including every stored entry CRC.
function unpack(bytes) {
  const files = new Map()
  let offset = 0
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'Unexpected ZIP compression method')
    const size = bytes.readUInt32LE(offset + 18)
    const length = bytes.readUInt16LE(offset + 26)
    const extra = bytes.readUInt16LE(offset + 28)
    const path = bytes.subarray(offset + 30, offset + 30 + length).toString()
    const start = offset + 30 + length + extra
    const content = bytes.subarray(start, start + size)
    assert.equal(crc32(content), bytes.readUInt32LE(offset + 14), `ZIP CRC mismatch: ${path}`)
    assert.ok(!files.has(path), `Duplicate ZIP path: ${path}`)
    files.set(path, content)
    offset = start + size
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'ZIP central directory missing')
  return files
}

mkdirSync(resolve(root, 'dist/packages'), { recursive: true })
for (const name of selected.length ? selected : Object.keys(products)) {
  const files = artifactFiles(resolve(root, 'dist', name))
  const { version } = checkFiles(name, files)
  const path = resolve(root, 'dist/packages', `${name}-${version}.zip`)
  writeFileSync(path, archive(files))
  const packed = unpack(readFileSync(path))
  assert.equal(packed.size, files.size)
  checkFiles(name, packed)
  console.log(`Packaged and verified ${path}`)
}
