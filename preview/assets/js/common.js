
  // Common i18n & capabilities detection (v4 with observed_source)
  const MESH_CAPABILITIES = {
    surface: {
      version: 4,
      observed_source: "socket"
    },
    capabilities: [
      "key.approve",
      "agent.teardown",
      "group.manage",
      "policy.send_restrict",
      "audit.read_content",
      "audit.read_metadata"
    ]
  };

  console.log('[Agent Mesh Platform] Initialized with surface v' + MESH_CAPABILITIES.surface.version + ' (observed_source: ' + MESH_CAPABILITIES.surface.observed_source + ')');
