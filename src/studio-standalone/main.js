// Standalone Studio entry point: install the in-memory host, then run the
// unmodified graphical editor. Module evaluation happens before
// DOMContentLoaded, so the editor's init() sees the host from its first fetch.
import { installStudioHost } from './host.js';
import * as runtime from 'mwgp:studio-runtime';
import '../../public/studio.js';

installStudioHost(runtime);
