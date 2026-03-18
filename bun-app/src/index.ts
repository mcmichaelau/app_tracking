import { startServer, startTracker } from "./server";
import { configure } from "./interpretation";

await configure();
await startServer();
startTracker();
