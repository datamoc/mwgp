import { Buffer } from 'buffer';
import { unzlibSync } from 'fflate';
export const inflateSync = bytes => Buffer.from(unzlibSync(bytes));
