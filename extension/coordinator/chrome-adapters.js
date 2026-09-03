(function initializeChromeCoordinatorAdapters(root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.WebMcpChromeCoordinatorAdapters = api;
}(typeof globalThis === 'undefined' ? this : globalThis, () => {
  'use strict';

  const RUNS_KEY = 'webMcpDurableRuns';
  const OBSERVATIONS_KEY = 'webMcpRunObservations';
  const OWNED_TABS_KEY = 'webMcpCoordinatorTabs';
  const MAX_OBSERVATIONS = 500;

  const createSerializedMutator = () => {
    let queue = Promise.resolve();
    return (task) => {
      const result = queue.then(task, task);
      queue = result.catch(() => {});
      return result;
    };
  };

  const createChromeRunStorage = (area) => {
    const mutate = createSerializedMutator();
    const readAll = async () => {
      const values = await area.get(RUNS_KEY);
      return values[RUNS_KEY] || {};
    };
    return {
      async list() {
        return Object.values(await readAll());
      },
      async load(runId) {
        const runs = await readAll();
        return runs[runId] || null;
      },
      save(record) {
        return mutate(async () => {
          const runs = await readAll();
          runs[record.runId] = record;
          await area.set({ [RUNS_KEY]: runs });
        });
      },
    };
  };

  const createChromeObservationStore = (area) => {
    const mutate = createSerializedMutator();
    return {
      save(observation) {
        return mutate(async () => {
          const values = await area.get(OBSERVATIONS_KEY);
          const observations = values[OBSERVATIONS_KEY] || [];
          observations.push(observation);
          await area.set({
            [OBSERVATIONS_KEY]: observations.slice(-MAX_OBSERVATIONS),
          });
        });
      },
    };
  };

  const createChromeTabs = (chromeApi, area) => {
    const mutate = createSerializedMutator();
    const readOwned = async () => {
      const values = await area.get(OWNED_TABS_KEY);
      return values[OWNED_TABS_KEY] || [];
    };
    const writeOwned = (ids) => area.set({ [OWNED_TABS_KEY]: ids });

    return {
      async create(options) {
        const tab = await chromeApi.tabs.create({ ...options, active: false });
        await mutate(async () => {
          const ids = await readOwned();
          if (!ids.includes(tab.id)) await writeOwned([...ids, tab.id]);
        });
        return tab;
      },
      async findReusable({ excludeTabIds = [], origin }) {
        const [ids, tabs] = await Promise.all([readOwned(), chromeApi.tabs.query({ active: false })]);
        return tabs.find((tab) => {
          if (!ids.includes(tab.id) || excludeTabIds.includes(tab.id)) return false;
          try {
            return new URL(tab.url).origin === origin;
          } catch (error) {
            return false;
          }
        }) || null;
      },
      get(tabId) {
        return chromeApi.tabs.get(tabId);
      },
      async remove(tabId) {
        await chromeApi.tabs.remove(tabId);
        await mutate(async () => {
          const ids = await readOwned();
          await writeOwned(ids.filter((id) => id !== tabId));
        });
      },
      async forget(tabId) {
        await mutate(async () => {
          const ids = await readOwned();
          await writeOwned(ids.filter((id) => id !== tabId));
        });
      },
    };
  };

  const installChromeCoordinator = ({ chromeApi, coordinator, portHandlers = {}, tabClosedHandlers = [] }) => {
    chromeApi.runtime.onConnect.addListener((port) => {
      try {
        const handler = portHandlers[port.name];
        if (handler) handler(port);
        else coordinator.bindPort(port);
      } catch (error) {
        port.disconnect();
      }
    });
    chromeApi.tabs.onRemoved.addListener((tabId) => {
      void coordinator.tabClosed(tabId);
      tabClosedHandlers.forEach((handler) => { void handler(tabId); });
    });
    void coordinator.recover();
    return coordinator;
  };

  return {
    OBSERVATIONS_KEY,
    OWNED_TABS_KEY,
    RUNS_KEY,
    createChromeObservationStore,
    createChromeRunStorage,
    createChromeTabs,
    installChromeCoordinator,
  };
}));
