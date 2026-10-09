async function recoverWriterConflict(manager, threadId, error, timeoutMs = 5000, discoverOwner = null) {
  const message = String(error?.message ?? error).toLowerCase();
  if (!message.includes("already has an active writer") && !message.includes("already has a live local writer")) return false;
  const state = manager.streamState;
  const transport = state?.params?.transport;
  if (manager.disposed || manager.getHostId() !== "local" || !manager.ipcBridge || !transport?.sendFollowingChanged || !state.followedConversationIds.has(threadId)) {
    console.warn("[writer-recovery] unavailable", { disposed: manager.disposed, local: manager.getHostId() === "local", bridge: !!manager.ipcBridge, transport: !!transport?.sendFollowingChanged, following: state?.followedConversationIds?.has(threadId) ?? false });
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  try {
    const params = {
      hostId: manager.getHostId(), conversationId: threadId,
    };
    const owner = discoverOwner
      ? { resultType: "success", handledByClientId: await discoverOwner(params) }
      : await manager.ipcBridge.request("thread-owner-discovery", params, { timeoutMs });
    if (owner.resultType !== "success" || typeof owner.handledByClientId !== "string" || !owner.handledByClientId) { console.warn("[writer-recovery] owner unavailable"); return false; }
    if (manager.disposed || !state.followedConversationIds.has(threadId)) return false;
    await transport.sendFollowingChanged(threadId, manager.getHostId(), true, [owner.handledByClientId]);
    // ponytail: bounded wait for native snapshot; use a native subscription if this polling becomes costly.
    while (!manager.disposed && state.followedConversationIds.has(threadId)) {
      const role = manager.getStreamRole(threadId);
      if (role?.role === "follower" && role.ownerClientId === owner.handledByClientId && manager.getConversation(threadId)?.resumeState === "resumed") return true;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(25, deadline - Date.now()))));
    }
    console.warn("[writer-recovery] snapshot unavailable");
  } catch (failure) {
    console.warn("[writer-recovery] discovery or following request failed", String(failure?.message ?? failure).slice(0, 200));
    // Preserve original resume error when owner discovery or snapshot delivery fails.
  }
  return false;
}

module.exports = { recoverWriterConflict };
