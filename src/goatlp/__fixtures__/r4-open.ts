// Test preload: a filled r4 book (./r4-filled.ts) and the auto-range review switch on, so the whole r4 port is tested.
import './r4-filled';
import { R4_REVIEW } from '../r4book';

R4_REVIEW.autoRange = true;
