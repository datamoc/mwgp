// RGSS compatibility for Ruby Marshal's `C` tag (a subclass of String,
// Array, Regexp, or Hash). mwg's decoder remains the primary implementation;
// this bounded reader is only used when its explicit unsupported-tag error is
// a UCLASS value. The subclass marker is metadata for the player, so Array
// identity and Marshal backreferences stay attached to the real array.
export const rubySubclass = Symbol('rubySubclass');

class Reader {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.pos = 0;
    this.symbols = [];
    this.objects = [];
    this.depth = 0;
  }
  byte() {
    if (this.pos >= this.bytes.length) throw new Error('Marshal: unexpected end of input');
    return this.bytes[this.pos++];
  }
  take(count) {
    if (count < 0 || this.pos + count > this.bytes.length) throw new Error('Marshal: invalid byte length');
    const value = this.bytes.subarray(this.pos, this.pos + count);
    this.pos += count;
    return value;
  }
  fixnum() {
    const c = (this.byte() << 24) >> 24;
    if (c === 0) return 0;
    if (c >= 5) return c - 5;
    if (c <= -5) return c + 5;
    const count = Math.abs(c);
    let value = c > 0 ? 0 : -1;
    for (let i = 0; i < count; i++) {
      const shift = i * 8;
      value = c > 0 ? value | (this.byte() << shift) : (value & ~(0xff << shift)) | (this.byte() << shift);
    }
    return value;
  }
  bytesValue() { return this.take(this.fixnum()); }
  symbol() {
    const value = new TextDecoder().decode(this.bytesValue());
    this.symbols.push(value);
    return value;
  }
  symbolValue() {
    const tag = String.fromCharCode(this.byte());
    if (tag === ':') return this.symbol();
    if (tag === ';') {
      const value = this.symbols[this.fixnum()];
      if (value === undefined) throw new Error('Marshal: symbol link out of range');
      return value;
    }
    throw new Error(`Marshal: expected a symbol, got tag "${tag}"`);
  }
  link(value) { this.objects.push(value); return value; }
  ivars() {
    const count = this.fixnum(), result = {};
    for (let i = 0; i < count; i++) result[this.symbolValue()] = this.value();
    return result;
  }
  array() {
    const result = this.link([]), count = this.fixnum();
    for (let i = 0; i < count; i++) result.push(this.value());
    return result;
  }
  hash(withDefault) {
    const result = this.link(new Map()), count = this.fixnum();
    for (let i = 0; i < count; i++) result.set(this.value(), this.value());
    if (withDefault) result.defaultValue = this.value();
    return result;
  }
  value() {
    if (++this.depth > 1000) throw new Error('Marshal: values nested more than 1000 deep');
    try {
      switch (String.fromCharCode(this.byte())) {
        case '0': return null;
        case 'T': return true;
        case 'F': return false;
        case 'i': return this.fixnum();
        case 'l': {
          const sign = String.fromCharCode(this.byte()) === '-' ? -1 : 1, words = this.fixnum();
          let value = 0, multiplier = 1;
          for (let i = 0; i < words; i++) { value += (this.byte() | (this.byte() << 8)) * multiplier; multiplier *= 65536; }
          return this.link(sign * value);
        }
        case 'f': {
          const text = new TextDecoder().decode(this.bytesValue());
          return this.link(text === 'inf' ? Infinity : text === '-inf' ? -Infinity : text === 'nan' ? NaN : Number(text));
        }
        case ':': return this.symbol();
        case ';': {
          const value = this.symbols[this.fixnum()];
          if (value === undefined) throw new Error('Marshal: symbol link out of range');
          return value;
        }
        case '"': return this.link(new TextDecoder().decode(this.bytesValue()));
        case '[': return this.array();
        case '{': return this.hash(false);
        case '}': return this.hash(true);
        case 'o': {
          const result = this.link({ class: '', ivars: {} });
          result.class = this.symbolValue();
          result.ivars = this.ivars();
          return result;
        }
        case 'I': {
          const result = this.value(), ivars = this.ivars();
          if (result?.[rubySubclass]) result[rubySubclass].ivars = ivars;
          return result;
        }
        case 'C': {
          const className = this.symbolValue();
          const objectIndex = this.objects.length;
          const result = this.value();
          if (result && (Array.isArray(result) || result instanceof Map)) {
            Object.defineProperty(result, rubySubclass, { value: { class: className, ivars: {} }, configurable: true });
            return result;
          }
          const wrapped = { $rubySubclass: { class: className, value: result, ivars: {} } };
          if (this.objects.length > objectIndex) this.objects[objectIndex] = wrapped;
          return wrapped;
        }
        case 'u': {
          const result = this.link({ class: '', raw: new Uint8Array() });
          result.class = this.symbolValue();
          result.raw = this.bytesValue().slice();
          return result;
        }
        case 'U': {
          const result = this.link({ class: '', value: null });
          result.class = this.symbolValue();
          result.value = this.value();
          return result;
        }
        case '@': {
          const result = this.objects[this.fixnum()];
          if (result === undefined) throw new Error('Marshal: object link out of range');
          return result;
        }
        default: throw new Error(`Marshal: unsupported tag in RGSS subclass payload at byte ${this.pos - 1}`);
      }
    } finally { this.depth--; }
  }
  document() {
    const major = this.byte(), minor = this.byte();
    if (major !== 4 || minor > 8) throw new Error(`Marshal: unsupported version ${major}.${minor}`);
    return this.value();
  }
}

export function decodeRgssMarshal(bytes, decodeMwg) {
  try { return decodeMwg(bytes); }
  catch (error) {
    if (!/unsupported tag "C" \(0x43\)/.test(String(error?.message || error))) throw error;
    return new Reader(bytes).document();
  }
}
