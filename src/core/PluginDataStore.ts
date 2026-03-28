export interface PluginDataStore {
  loadData(): Promise<Record<string, any> | null | undefined>;
  saveData(data: Record<string, any>): Promise<void>;
}

const writeQueues = new WeakMap<PluginDataStore, Promise<void>>();

export async function mergeAndSavePluginData(
  plugin: PluginDataStore,
  update: (data: Record<string, any>) => void | Promise<void>,
): Promise<void> {
  const run = async () => {
    const data = ((await plugin.loadData()) || {}) as Record<string, any>;
    await update(data);
    await plugin.saveData(data);
  };

  const prior = writeQueues.get(plugin) || Promise.resolve();
  const queued = prior.then(run, run);
  writeQueues.set(
    plugin,
    queued.catch(() => {}),
  );
  return queued;
}
