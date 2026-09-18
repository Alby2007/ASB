import { EventPipeline } from '../src/event-detection.ts';
import { MemoryStore } from '../src/database.ts';
import { EventStore } from '../src/events.ts';
import { guildBrain, requireGuildId } from './_lib.mjs';

const GUILD_ID = requireGuildId();
const store = await MemoryStore.create();
const eventStore = new EventStore();
const brain = await guildBrain(store, GUILD_ID);
const pipeline = new EventPipeline();
const result = await pipeline.maintainEvents(GUILD_ID, eventStore, store, brain);
console.log('closed=' + result.closed + ' promoted=' + result.promoted + ' discarded=' + result.discarded);
process.exit(0);
