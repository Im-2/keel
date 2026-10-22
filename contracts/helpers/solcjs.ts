// Optional: compile with the npm `solc` (solcjs) package instead of downloading a native compiler.
// Enable with KEEL_SOLCJS=1 (useful in sandboxed CI where binaries.soliditylang.org is unreachable).
import { subtask } from "hardhat/config"
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names"

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: any, _hre, runSuper) => {
  if (process.env.KEEL_SOLCJS === "1" && args.solcVersion === "0.8.24") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const solc = require("solc")
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solc.version(),
    }
  }
  return runSuper()
})
