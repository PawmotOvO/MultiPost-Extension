import { Storage } from "@plasmohq/storage";
import { addTabsManagerMessages } from "~background/services/tabs";
import { getAllAccountInfo } from "~sync/account";
import { type SyncData, type SyncDataPlatform, createTabsForPlatforms } from "~sync/common";

const DEFAULT_URL = "ws://localhost:8787";
const PROFILE_ID_KEY = "multipost_profile_id";
const COORDINATOR_URL_KEY = "multipost_coordinator_url";

const storage = new Storage({ area: "local" });

interface CoordinatorAccount {
  provider: string;
  accountId: string;
  username: string;
  profileId?: string;
}

interface PublishTaskMessage {
  type: "PUBLISH_TASK";
  taskId: string;
  syncData: SyncData;
}

interface PublishResultItem {
  platform: string;
  accountId?: string;
  status: "success" | "failed";
  error?: string;
}

let profileId: string | null = null;
let ws: WebSocket | null = null;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let manualClose = false;

export const coordinator = {
  get connected() {
    return ws?.readyState === WebSocket.OPEN;
  },

  get profileId() {
    return profileId;
  },

  async start() {
    profileId = (await storage.get<string>(PROFILE_ID_KEY)) || null;
    if (!profileId) {
      profileId = crypto.randomUUID();
      await storage.set(PROFILE_ID_KEY, profileId);
    }
    manualClose = false;
    connect();
  },

  stop() {
    manualClose = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  },

  /** Publish (initiate) a task through the coordinator. Returns the aggregated results. */
  publish(syncData: SyncData): Promise<PublishResultItem[]> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("Coordinator not connected"));
        return;
      }
      const taskId = crypto.randomUUID();
      const onMessage = (event: MessageEvent) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "PUBLISH_DONE" && msg.taskId === taskId) {
          ws?.removeEventListener("message", onMessage);
          resolve(msg.results || []);
        }
      };
      ws?.addEventListener("message", onMessage);
      ws?.send(JSON.stringify({ type: "PUBLISH", taskId, syncData }));
    });
  },

  /** Fetch the merged account list from the coordinator. */
  getAccounts(): Promise<CoordinatorAccount[]> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("Coordinator not connected"));
        return;
      }
      const onMessage = (event: MessageEvent) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "ACCOUNTS") {
          ws?.removeEventListener("message", onMessage);
          resolve(msg.accounts || []);
        }
      };
      ws?.addEventListener("message", onMessage);
      ws?.send(JSON.stringify({ type: "GET_ACCOUNTS" }));
    });
  },

  /** Notify the coordinator that this profile's account list changed. */
  async updateAccounts() {
    if (!this.connected) return;
    const accounts = await loadAccounts();
    ws?.send(JSON.stringify({ type: "ACCOUNT_UPDATE", profileId, accounts }));
  },
};

async function loadAccounts(): Promise<CoordinatorAccount[]> {
  const map = await getAllAccountInfo();
  return Object.entries(map).map(([provider, info]) => ({
    provider,
    accountId: info.accountId,
    username: info.username,
  }));
}

function connect() {
  storage.get<string>(COORDINATOR_URL_KEY).then((url) => {
    const wsUrl = url || DEFAULT_URL;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = async () => {
      reconnectDelay = 1000;
      const accounts = await loadAccounts();
      ws?.send(JSON.stringify({ type: "REGISTER", profileId, accounts }));
      console.log(`[coordinator] connected as ${profileId} (${accounts.length} accounts)`);
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "PUBLISH_TASK") {
        handlePublishTask(msg as PublishTaskMessage);
      }
    };

    ws.onclose = () => {
      console.log("[coordinator] disconnected");
      if (!manualClose) scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow
    };
  });
}

function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    connect();
  }, reconnectDelay);
}

async function handlePublishTask(msg: PublishTaskMessage) {
  const { taskId, syncData } = msg;
  const results: PublishResultItem[] = [];

  try {
    const tabs = await createTabsForPlatforms(syncData);
    addTabsManagerMessages({
      syncData,
      tabs: tabs.map((t) => ({ tab: t.tab, platformInfo: t.platformInfo })),
    });

    for (const t of tabs) {
      results.push({
        platform: t.platformInfo.name,
        accountId: (t.platformInfo as SyncDataPlatform).accountId,
        status: "success",
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    for (const p of syncData.platforms) {
      results.push({
        platform: p.name,
        accountId: p.accountId,
        status: "failed",
        error,
      });
    }
  }

  ws?.send(JSON.stringify({ type: "PUBLISH_RESULT", taskId, profileId, results }));
}
