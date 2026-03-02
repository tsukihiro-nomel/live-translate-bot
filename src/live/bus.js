import { EventEmitter } from 'node:events';

// Central event bus: Discord voice -> AI -> Overlay WS
export const bus = new EventEmitter();

// Event types we emit:
// - speaker.update
// - caption.interim
// - caption.final
// - status
