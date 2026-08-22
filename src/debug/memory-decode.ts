import type { DebugMemory } from '../core/debug-model.ts';

/**
 * Reading raw memory as the things it is likely to be.
 *
 * ## Why a hex dump is not enough
 *
 * A native debugger will hand you 256 bytes and a hex view, and a hex view is where most people
 * stop — because working out by eye whether those bytes are a UTF-16 string, a length-prefixed
 * buffer, an array of 32-bit integers or a struct with three pointers in it is slow, error-prone
 * work that a machine should be doing. IDEs mostly do not do it: they show hex, ASCII, and if you
 * are lucky a "view as" dropdown you have to drive by hand.
 *
 * This module reads a block **every plausible way at once** and reports which readings are
 * coherent. That is the whole trick: a block of bytes that decodes to printable UTF-16 with a NUL
 * terminator is almost certainly a wide string, and one whose first four bytes equal the number of
 * printable bytes that follow is almost certainly length-prefixed. Neither conclusion needs to
 * know the language, which is the point — this is the "any level" half of the brief, and it works
 * the same for C, Rust, Zig, assembly or a managed runtime that happened to expose an address.
 *
 * ## Honesty, again
 *
 * Every reading carries a plausibility score and the reason for it. Nothing here claims to know
 * what the bytes *are* — only which interpretations are self-consistent. A reader picks; the
 * module does not decide on their behalf, because a confident wrong reading of memory sends
 * someone chasing a corruption that never happened.
 */

export type Endianness = 'little' | 'big';

export interface Reading {
  /** What this reading treats the bytes as. */
  as: string;
  /** The decoded value, rendered. */
  value: string;
  /** 0 to 1. How self-consistent the reading is, never a claim about the truth. */
  plausibility: number;
  /** Why the score is what it is. */
  because: string;
  /** How many bytes the reading consumed. */
  bytes?: number;
}

export interface DecodedMemory {
  address?: string;
  byteCount: number;
  /** Readings, most plausible first. */
  readings: Reading[];
  /** Pointer-sized words, useful for spotting a struct full of pointers. */
  words?: Array<{ offset: number; hex: string; looksLikePointer: boolean }>;
  /** Runs of printable text found anywhere in the block, with offsets. */
  strings: Array<{ offset: number; text: string; encoding: 'ascii' | 'utf16' }>;
  /** True when the block is all zeroes — usually uninitialized or freed memory. */
  allZero: boolean;
  /** True when the block repeats a known debug fill pattern. */
  fillPattern?: string;
}

/**
 * Well-known debug fill patterns.
 *
 * Recognizing these is disproportionately valuable: `0xCDCDCDCD` in a Windows debug build means
 * *uninitialized heap*, and `0xDDDDDDDD` means *already freed*. Someone staring at a hex dump
 * wondering why their struct is full of nonsense has, in those cases, already found their bug —
 * and will not find it if nothing tells them what the pattern means.
 */
const FILL_PATTERNS: Array<{ byte: number; meaning: string }> = [
  { byte: 0xcd, meaning: 'uninitialized heap memory (MSVC debug fill)' },
  { byte: 0xcc, meaning: 'uninitialized stack memory, or an int3 breakpoint byte (MSVC)' },
  { byte: 0xdd, meaning: 'freed heap memory (MSVC debug fill) — this is a use-after-free' },
  { byte: 0xfd, meaning: 'a guard region past the end of an allocation (MSVC) — this is an overrun' },
  { byte: 0xab, meaning: 'LocalAlloc/HeapAlloc debug fill' },
  { byte: 0xbe, meaning: 'uninitialized memory (some allocators use 0xBEBEBEBE)' },
  { byte: 0xa5, meaning: 'uninitialized memory or a stack canary (some RTOS and embedded allocators)' },
  { byte: 0xef, meaning: 'freed memory (jemalloc junk fill)' },
];

export interface DecodeOptions {
  endianness?: Endianness;
  /** Pointer width in bytes, from the target architecture. */
  pointerSize?: 4 | 8;
  /** How many readings to return. */
  limit?: number;
}

/** Reads a captured block every plausible way. */
export function decodeMemory(dump: DebugMemory, options: DecodeOptions = {}): DecodedMemory {
  const bytes = Buffer.from(dump.base64, 'base64');
  return decodeBytes(bytes, { ...options, address: dump.address });
}

/** As {@link decodeMemory}, for bytes from anywhere. */
export function decodeBytes(
  bytes: Buffer,
  options: DecodeOptions & { address?: string } = {},
): DecodedMemory {
  const endianness = options.endianness ?? 'little';    // Every mainstream architecture today.
  const pointerSize = options.pointerSize ?? 8;
  const readings: Reading[] = [];

  const allZero = bytes.length > 0 && bytes.every((byte) => byte === 0);
  const fill = detectFill(bytes);

  if (allZero) {
    readings.push({
      as: 'zeroed memory',
      value: `${bytes.length} zero bytes`,
      plausibility: 1,
      because: 'every byte is zero: a null struct, a cleared buffer, or memory never written to',
    });
  }
  if (fill) {
    readings.push({
      as: 'debug fill pattern',
      value: `0x${fill.byte.toString(16).toUpperCase().repeat(2)} repeated`,
      plausibility: 1,
      because: fill.meaning,
    });
  }

  // -- Strings, in both widths.
  const asciiString = readCString(bytes, 'ascii');
  if (asciiString) readings.push(asciiString);

  const wideString = readCString(bytes, 'utf16');
  if (wideString) readings.push(wideString);

  const prefixed = readLengthPrefixed(bytes, endianness);
  if (prefixed) readings.push(prefixed);

  // -- Numeric arrays.
  for (const width of [1, 2, 4, 8] as const) {
    const reading = readNumericArray(bytes, width, endianness);
    if (reading) readings.push(reading);
  }

  const floats = readFloatArray(bytes, endianness);
  if (floats) readings.push(floats);

  // -- Pointer table.
  const words = readWords(bytes, pointerSize, endianness);
  const pointerish = words.filter((word) => word.looksLikePointer).length;

  if (words.length > 0 && pointerish >= Math.max(2, words.length * 0.5)) {
    readings.push({
      as: `array or struct of ${pointerSize * 8}-bit pointers`,
      value: words.slice(0, 8).map((word) => word.hex).join(' '),
      // Two independent signals agree here: the values are in a plausible address range *and* they
      // are aligned to the pointer size. Either alone is weak.
      plausibility: Math.min(0.9, 0.4 + (pointerish / Math.max(1, words.length)) * 0.5),
      because: `${pointerish} of ${words.length} aligned words are in a plausible address range`,
      bytes: words.length * pointerSize,
    });
  }

  readings.sort((a, b) => b.plausibility - a.plausibility);

  return {
    address: options.address,
    byteCount: bytes.length,
    readings: readings.slice(0, options.limit ?? 10),
    words: words.length > 0 ? words.slice(0, 32) : undefined,
    strings: findStrings(bytes),
    allZero,
    fillPattern: fill?.meaning,
  };
}

/** A repeated single-byte fill, which is what every debug allocator writes. */
function detectFill(bytes: Buffer): { byte: number; meaning: string } | undefined {
  if (bytes.length < 8) return undefined;
  const first = bytes[0]!;
  if (!bytes.every((byte) => byte === first)) return undefined;

  return FILL_PATTERNS.find((pattern) => pattern.byte === first)
    ?? { byte: first, meaning: `every byte is 0x${first.toString(16).toUpperCase().padStart(2, '0')}` };
}

/** A NUL-terminated string starting at offset zero, in one of the two common widths. */
function readCString(bytes: Buffer, encoding: 'ascii' | 'utf16'): Reading | undefined {
  const step = encoding === 'utf16' ? 2 : 1;
  let length = 0;
  let printable = 0;

  for (let offset = 0; offset + step <= bytes.length; offset += step) {
    const code = encoding === 'utf16' ? bytes.readUInt16LE(offset) : bytes[offset]!;
    if (code === 0) break;
    length++;
    if (isPrintable(code)) printable++;
    else if (length > 2 && printable / length < 0.7) return undefined;  // Give up early on binary.
  }

  if (length < 2) return undefined;
  const ratio = printable / length;
  if (ratio < 0.8) return undefined;

  const terminated = (length + 1) * step <= bytes.length;
  const text = encoding === 'utf16'
    ? bytes.subarray(0, length * 2).toString('utf16le')
    : bytes.subarray(0, length).toString('latin1');

  return {
    as: encoding === 'utf16' ? 'UTF-16 string' : 'C string (ASCII/UTF-8)',
    value: JSON.stringify(text),
    // A terminator is the strongest single signal that this is a string rather than bytes that
    // happen to be printable.
    plausibility: Math.min(0.98, ratio * (terminated ? 1 : 0.7)),
    because: `${length} character(s), ${Math.round(ratio * 100)}% printable` +
      (terminated ? ', NUL-terminated' : ', no terminator found in the captured block'),
    bytes: (length + (terminated ? 1 : 0)) * step,
  };
}

/**
 * A length-prefixed buffer: a count, then that many bytes.
 *
 * The check that makes this worth doing is that the prefix has to *agree* with the data — a
 * four-byte header claiming 39 characters followed by 39 printable bytes is not a coincidence. Go
 * strings, Pascal strings, .NET `BSTR`, length-prefixed protocol frames and most serialization
 * formats all look like this.
 */
function readLengthPrefixed(bytes: Buffer, endianness: Endianness): Reading | undefined {
  for (const width of [1, 2, 4, 8] as const) {
    if (bytes.length < width + 2) continue;

    let declared: number;
    try {
      declared = width === 1 ? bytes.readUInt8(0)
        : width === 2 ? (endianness === 'little' ? bytes.readUInt16LE(0) : bytes.readUInt16BE(0))
        : width === 4 ? (endianness === 'little' ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0))
        : Number(endianness === 'little' ? bytes.readBigUInt64LE(0) : bytes.readBigUInt64BE(0));
    } catch {
      continue;
    }

    if (declared < 2 || declared > bytes.length - width) continue;

    const body = bytes.subarray(width, width + declared);
    const printable = [...body].filter((byte) => isPrintable(byte)).length / Math.max(1, body.length);
    if (printable < 0.85) continue;

    return {
      as: `${width * 8}-bit length prefix followed by text`,
      value: `len=${declared} ${JSON.stringify(body.toString('latin1'))}`,
      plausibility: Math.min(0.95, 0.6 + printable * 0.35),
      because: `the first ${width} byte(s) say ${declared}, and ${declared} printable bytes follow`,
      bytes: width + declared,
    };
  }
  return undefined;
}

/** An array of fixed-width integers, scored on whether the values look like data or noise. */
function readNumericArray(bytes: Buffer, width: 1 | 2 | 4 | 8, endianness: Endianness): Reading | undefined {
  if (bytes.length < width * 4 || bytes.length % width !== 0) return undefined;

  const values: number[] = [];
  const count = Math.min(bytes.length / width, 64);

  for (let index = 0; index < count; index++) {
    const offset = index * width;
    values.push(
      width === 1 ? bytes.readUInt8(offset)
        : width === 2 ? (endianness === 'little' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset))
        : width === 4 ? (endianness === 'little' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset))
        : Number(endianness === 'little' ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)),
    );
  }

  // Small magnitudes are the signal. Real integer data clusters near zero far more often than
  // random bytes do, and a block of pointers or floats reinterpreted as integers does not.
  const small = values.filter((value) => Math.abs(value) < 65536).length / values.length;
  if (small < 0.5) return undefined;

  return {
    as: `${width * 8}-bit unsigned integers (${endianness}-endian)`,
    value: values.slice(0, 12).join(', ') + (values.length > 12 ? ', …' : ''),
    plausibility: Math.min(0.75, 0.3 + small * 0.45),
    because: `${Math.round(small * 100)}% of values are small enough to look like real data`,
    bytes: count * width,
  };
}

/** An array of 32- or 64-bit floats, scored on how many are finite and in a human range. */
function readFloatArray(bytes: Buffer, endianness: Endianness): Reading | undefined {
  for (const width of [8, 4] as const) {
    if (bytes.length < width * 2 || bytes.length % width !== 0) continue;

    const values: number[] = [];
    const count = Math.min(bytes.length / width, 32);

    for (let index = 0; index < count; index++) {
      const offset = index * width;
      values.push(width === 4
        ? (endianness === 'little' ? bytes.readFloatLE(offset) : bytes.readFloatBE(offset))
        : (endianness === 'little' ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset)));
    }

    // Almost any byte pattern decodes to *a* float, so the score comes from how many land in the
    // range real numbers actually occupy. Without this the reading would fire on everything.
    const sane = values.filter((value) =>
      Number.isFinite(value) && (value === 0 || (Math.abs(value) > 1e-6 && Math.abs(value) < 1e12)));

    if (sane.length / values.length < 0.8) continue;

    return {
      as: `${width * 8}-bit floating point (${endianness}-endian)`,
      value: sane.slice(0, 8).map((value) => Number(value.toPrecision(6))).join(', '),
      plausibility: 0.55,
      because: `${sane.length} of ${values.length} decode to finite numbers in an ordinary range`,
      bytes: count * width,
    };
  }
  return undefined;
}

/** Splits into pointer-sized aligned words and marks the ones in a plausible address range. */
function readWords(
  bytes: Buffer,
  size: 4 | 8,
  endianness: Endianness,
): Array<{ offset: number; hex: string; looksLikePointer: boolean }> {
  const words: Array<{ offset: number; hex: string; looksLikePointer: boolean }> = [];

  for (let offset = 0; offset + size <= bytes.length; offset += size) {
    const value = size === 4
      ? BigInt(endianness === 'little' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset))
      : (endianness === 'little' ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset));

    words.push({
      offset,
      hex: `0x${value.toString(16).padStart(size * 2, '0')}`,
      looksLikePointer: isPlausibleAddress(value, size),
    });
  }
  return words;
}

/**
 * Whether a word looks like a live pointer.
 *
 * Deliberately loose, because address space layout differs by platform and it is not this module's
 * job to know which one it is looking at. The three rules that hold nearly everywhere: a pointer is
 * not tiny (small integers are far more likely to be counts), it is aligned, and on 64-bit it does
 * not use the top sixteen bits — current hardware only implements 48 address bits, so a value with
 * the high bits set is an integer or a tagged value, not an address.
 */
function isPlausibleAddress(value: bigint, size: 4 | 8): boolean {
  if (value === 0n) return false;
  if (value < 0x1000n) return false;
  if (value % 4n !== 0n) return false;
  if (size === 8 && value > 0x0000_7fff_ffff_ffffn) return false;
  return true;
}

/** Every run of printable characters, in either width, with its offset. */
function findStrings(
  bytes: Buffer,
  minimum = 4,
): Array<{ offset: number; text: string; encoding: 'ascii' | 'utf16' }> {
  const found: Array<{ offset: number; text: string; encoding: 'ascii' | 'utf16' }> = [];

  let start = -1;
  for (let offset = 0; offset <= bytes.length; offset++) {
    const printable = offset < bytes.length && isPrintable(bytes[offset]!);

    if (printable && start < 0) start = offset;
    else if (!printable && start >= 0) {
      if (offset - start >= minimum) {
        found.push({ offset: start, text: bytes.subarray(start, offset).toString('latin1'), encoding: 'ascii' });
      }
      start = -1;
    }
  }

  // UTF-16: printable bytes separated by zeroes, which is what a wide string looks like in a hex
  // dump and which the ASCII scan above chops into single characters.
  let wideStart = -1;
  for (let offset = 0; offset + 1 <= bytes.length; offset += 2) {
    const wide = isPrintable(bytes[offset]!) && bytes[offset + 1] === 0;

    if (wide && wideStart < 0) wideStart = offset;
    else if (!wide && wideStart >= 0) {
      if ((offset - wideStart) / 2 >= minimum) {
        found.push({
          offset: wideStart,
          text: bytes.subarray(wideStart, offset).toString('utf16le'),
          encoding: 'utf16',
        });
      }
      wideStart = -1;
    }
  }

  return found.sort((a, b) => a.offset - b.offset).slice(0, 20);
}

function isPrintable(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code === 0x0d;
}

// ---------------------------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------------------------

export interface DecodedRegister {
  name: string;
  value: string;
  /** What this register is for on its architecture, when it is a known one. */
  role?: string;
  /** The value as a signed decimal, for registers holding counts rather than addresses. */
  signed?: string;
  looksLikePointer?: boolean;
}

/**
 * Roles of the registers that matter when reading a stopped program.
 *
 * Only the ones whose role is *architectural* rather than conventional, because those are the ones
 * that mean the same thing in every program: the stack pointer, the frame pointer, the instruction
 * pointer, the flags, and the first few argument registers under each platform's calling
 * convention. A general-purpose register's meaning depends entirely on the code and no table can
 * supply it.
 */
const REGISTER_ROLES: Record<string, string> = {
  rip: 'instruction pointer — the address currently executing',
  eip: 'instruction pointer',
  pc: 'program counter — the address currently executing',
  rsp: 'stack pointer — the top of the stack',
  esp: 'stack pointer',
  sp: 'stack pointer',
  rbp: 'frame pointer — the base of the current frame',
  ebp: 'frame pointer',
  fp: 'frame pointer',
  x29: 'frame pointer (AArch64)',
  x30: 'link register — the return address (AArch64)',
  lr: 'link register — the return address',
  rax: 'return value / accumulator (System V and Windows x64)',
  eax: 'return value / accumulator',
  x0: 'first argument and return value (AArch64)',
  rdi: 'first argument (System V x64)',
  rsi: 'second argument (System V x64)',
  rdx: 'third argument (System V x64)',
  rcx: 'first argument (Windows x64) / fourth (System V)',
  r8: 'third argument (Windows x64) / fifth (System V)',
  r9: 'fourth argument (Windows x64) / sixth (System V)',
  eflags: 'status flags — comparison and arithmetic results',
  rflags: 'status flags',
  cpsr: 'status flags (ARM)',
};

/**
 * Annotates a register scope.
 *
 * Registers arrive from DAP as a scope full of variables with hexadecimal values and no
 * explanation. Naming the architectural roles turns an unreadable wall into the three or four
 * entries a person actually wanted — where execution is, where the stack is, what the last
 * comparison decided.
 */
export function decodeRegisters(
  registers: Array<{ name: string; value: string }>,
  pointerSize: 4 | 8 = 8,
): DecodedRegister[] {
  return registers.map((register) => {
    const name = register.name.toLowerCase().replace(/^\$/, '');
    const hex = /0x[0-9a-fA-F]+/.exec(register.value)?.[0];
    let value: bigint | undefined;

    try {
      value = hex ? BigInt(hex) : BigInt(register.value.trim());
    } catch {
      value = undefined;
    }

    return {
      name: register.name,
      value: register.value,
      role: REGISTER_ROLES[name],
      // Two's-complement, because a register holding -1 prints as 0xFFFFFFFFFFFFFFFF and a reader
      // seeing that will not recognize it as a count that went below zero -- which is exactly the
      // bug it usually is.
      signed: value !== undefined ? String(toSigned(value, pointerSize)) : undefined,
      looksLikePointer: value !== undefined ? isPlausibleAddress(value, pointerSize) : undefined,
    };
  });
}

function toSigned(value: bigint, size: 4 | 8): bigint {
  const bits = BigInt(size * 8);
  const limit = 1n << (bits - 1n);
  return value >= limit ? value - (1n << bits) : value;
}

/** Renders a decoded block for a terminal or a briefing. */
export function renderDecodedMemory(decoded: DecodedMemory, indent = ''): string[] {
  const lines: string[] = [];

  lines.push(`${indent}${decoded.address ?? 'memory'} — ${decoded.byteCount} bytes`);
  if (decoded.fillPattern) lines.push(`${indent}  ⚠ ${decoded.fillPattern}`);

  for (const reading of decoded.readings) {
    const score = Math.round(reading.plausibility * 100);
    lines.push(`${indent}  [${String(score).padStart(3)}%] ${reading.as}: ${clip(reading.value, 100)}`);
    lines.push(`${indent}         ${reading.because}`);
  }

  if (decoded.strings.length > 0 && !decoded.readings.some((reading) => reading.as.includes('string'))) {
    lines.push(`${indent}  text found inside:`);
    for (const found of decoded.strings.slice(0, 6)) {
      lines.push(`${indent}    +0x${found.offset.toString(16)} ${JSON.stringify(found.text)} (${found.encoding})`);
    }
  }
  return lines;
}

function clip(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}
