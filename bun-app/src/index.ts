import { startServer, startTracker } from "./server";
import { configure } from "./interpretation";
import { startRetaskScheduler } from "./retask";

await configure();
await startServer();
startTracker();
startRetaskScheduler();
