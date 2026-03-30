import { startServer, startTracker } from "./server";
import { configure } from "./interpretation";
import { configureClassification } from "./classification";

await configure();
await configureClassification();
await startServer();
startTracker();
