/**
 * MultiPost Multi-Profile Coordinator Service
 *
 * A lightweight WebSocket server that coordinates multiple Chrome Profile
 * extension instances to enable simultaneous publishing to multiple accounts
 * of the same platform.
 *
 * Message protocol (all JSON):
 *
 *  Extension -> Coordinator:
 *    { type: "REGISTER", profileId, accounts: AccountInfo[] }
 *    { type: "ACCOUNT_UPDATE", profileId, accounts: AccountInfo[] }
 *    { type: "GET_ACCOUNTS" }
 *    { type: "PUBLISH", taskId, syncData }          // from initiating profile
 *    { type: "PUBLISH_RESULT", taskId, profileId, results: [{platform, accountId, status, error?}] }
 *
 *  Coordinator -> Extension:
 *    { type: "ACCOUNTS", accounts: (AccountInfo & {profileId})[] }
 *    { type: "PUBLISH_TASK", taskId, syncData }     // to target profile (platforms filtered)
 *    { type: "PUBLISH_DONE", taskId, results }      // to initiating profile
 */

const { WebSocketServer } = require("ws");

const PORT = process.env.MULTIPOST_COORDINATOR_PORT || 8787;

/** @type {Map<string, { ws: import('ws').WebSocket, accounts: any[] }>} */
const profiles = new Map();

/**
 * taskId -> { initiatorWs, expected: number, received: number, results: [] }
 */
const tasks = new Map();

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
};

const getAllAccounts = () => {
  const list = [];
  for (const [profileId, entry] of profiles) {
    for (const acc of entry.accounts || []) {
      list.push({ ...acc, profileId });
    }
  }
  return list;
};

const broadcastAccounts = () => {
  const accounts = getAllAccounts();
  for (const entry of profiles.values()) {
    send(entry.ws, { type: "ACCOUNTS", accounts });
  }
};

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  let profileId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "REGISTER": {
        profileId = msg.profileId;
        if (!profileId) return;
        profiles.set(profileId, { ws, accounts: msg.accounts || [] });
        console.log(`[coordinator] profile registered: ${profileId} (${(msg.accounts || []).length} accounts)`);
        // Send the merged list back to everyone (including the new one)
        broadcastAccounts();
        break;
      }

      case "ACCOUNT_UPDATE": {
        if (msg.profileId && profiles.has(msg.profileId)) {
          profiles.get(msg.profileId).accounts = msg.accounts || [];
          console.log(`[coordinator] accounts updated for ${msg.profileId}`);
          broadcastAccounts();
        }
        break;
      }

      case "GET_ACCOUNTS": {
        send(ws, { type: "ACCOUNTS", accounts: getAllAccounts() });
        break;
      }

      case "PUBLISH": {
        const { taskId, syncData } = msg;
        if (!taskId || !syncData?.platforms) return;

        // Group platforms by the profile that owns the target accountId
        const byProfile = new Map(); // profileId -> platforms[]
        for (const p of syncData.platforms) {
          const owner = findProfileByAccount(p.accountId);
          if (!owner) {
            console.warn(`[coordinator] no profile owns accountId=${p.accountId} for platform=${p.name}`);
            continue;
          }
          if (!byProfile.has(owner)) byProfile.set(owner, []);
          byProfile.get(owner).push(p);
        }

        const targetProfiles = [...byProfile.keys()];
        if (targetProfiles.length === 0) {
          send(ws, { type: "PUBLISH_DONE", taskId, results: [], error: "NO_PROFILE_MATCH" });
          return;
        }

        tasks.set(taskId, {
          initiatorWs: ws,
          expected: targetProfiles.length,
          received: 0,
          results: [],
        });

        // Dispatch a filtered syncData to each target profile
        for (const [pid, platforms] of byProfile) {
          const entry = profiles.get(pid);
          if (!entry) continue;
          send(entry.ws, {
            type: "PUBLISH_TASK",
            taskId,
            syncData: { ...syncData, platforms },
          });
        }
        console.log(`[coordinator] task ${taskId} dispatched to ${targetProfiles.length} profile(s)`);
        break;
      }

      case "PUBLISH_RESULT": {
        const { taskId, results } = msg;
        const task = tasks.get(taskId);
        if (!task) return;

        task.results.push(...(results || []));
        task.received += 1;

        if (task.received >= task.expected) {
          send(task.initiatorWs, { type: "PUBLISH_DONE", taskId, results: task.results });
          tasks.delete(taskId);
          console.log(`[coordinator] task ${taskId} done (${task.results.length} results)`);
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    if (profileId && profiles.get(profileId)?.ws === ws) {
      profiles.delete(profileId);
      console.log(`[coordinator] profile disconnected: ${profileId}`);
      broadcastAccounts();
    }
  });

  ws.on("error", (err) => {
    console.error("[coordinator] ws error:", err.message);
  });
});

function findProfileByAccount(accountId) {
  if (!accountId) return null;
  for (const [pid, entry] of profiles) {
    if ((entry.accounts || []).some((a) => a.accountId === accountId)) {
      return pid;
    }
  }
  return null;
}

console.log(`[coordinator] listening on ws://localhost:${PORT}`);
