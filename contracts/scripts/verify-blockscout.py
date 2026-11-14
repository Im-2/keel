"""
Verify Keel's contracts on the Mezo explorer (Blockscout) through its standard-JSON-input API.

For each contract it takes the exact compiler input hardhat used (build/build-info/*.json, compiled with the
solcjs override, solc 0.8.24+commit.e11b9ed9, optimizer 100 runs, EVM london), keeps only the sources listed in
that contract's own metadata, and submits it. Blockscout recompiles and compares the bytecode; constructor
arguments are detected from the creation transaction.

    python contracts/scripts/verify-blockscout.py            # every Keel contract in shared/deployments/testnet.json
    python contracts/scripts/verify-blockscout.py 0xabc...   # one address
"""
import glob, json, os, sys, time
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
API = os.environ.get("BLOCKSCOUT_API", "https://api.explorer.test.mezo.org/api/v2")

FILES = {
    "KeelGuardianFactory": "contracts/keel/KeelGuardianFactory.sol",
    "KeelGuardian": "contracts/keel/KeelGuardian.sol",
    "KeelPay": "contracts/keel/KeelPay.sol",
    "KeelGuardianFactoryV2": "contracts/keel/KeelGuardianFactoryV2.sol",
    "KeelGuardianV2": "contracts/keel/KeelGuardianV2.sol",
    "KeelPro": "contracts/keel/KeelPro.sol",
}


def targets():
    d = json.load(open(os.path.join(ROOT, "shared/deployments/testnet.json"), encoding="utf8"))
    k = d["keel"]
    out = [(k["guardianFactory"], "KeelGuardianFactoryV2"), (k["guardianImplementation"], "KeelGuardianV2"), (k["pay"], "KeelPay"), (k["pro"], "KeelPro")]
    for l in d.get("legacy", []):
        out += [(l["guardianFactory"], "KeelGuardianFactory"), (l["pay"], "KeelPay")]
        if l.get("guardianImplementation"):
            out.append((l["guardianImplementation"], "KeelGuardian"))
    return out


def build_info(name):
    """The newest build-info that compiled `name`."""
    path = FILES[name]
    found = []
    for f in glob.glob(os.path.join(ROOT, "contracts/build/build-info/*.json")):
        d = json.load(open(f, encoding="utf8"))
        if name in d["output"]["contracts"].get(path, {}):
            found.append((os.path.getmtime(f), d))
    if not found:
        raise SystemExit(f"{name} is not in any build-info; run `KEEL_SOLCJS=1 npx hardhat compile` first")
    return max(found, key=lambda x: x[0])[1]


def standard_input(name):
    d = build_info(name)
    path = FILES[name]
    meta = json.loads(d["output"]["contracts"][path][name]["metadata"])
    inp = d["input"]
    # only what this contract's metadata names: the same source set solc hashed into the bytecode
    sources = {p: inp["sources"][p] for p in meta["sources"]}
    settings = dict(inp["settings"])
    settings["outputSelection"] = {"*": {"*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"]}}
    version = "v" + d["solcLongVersion"].replace(".Emscripten.clang", "")
    return {"language": "Solidity", "sources": sources, "settings": settings}, version, path


def status(address):
    r = requests.get(f"{API}/smart-contracts/{address}", timeout=30)
    j = r.json() if r.ok else {}
    return bool(j.get("is_verified")), j.get("name")


def verify(address, name):
    ok, _ = status(address)
    if ok:
        print(f"{name:24s} {address}  already verified")
        return True
    std, version, path = standard_input(name)
    files = {"files[0]": (f"{name}.json", json.dumps(std), "application/json")}
    data = {
        "compiler_version": version,
        "contract_name": name,
        "license_type": "gnu_gpl_v3",
        "autodetect_constructor_args": "true",
    }
    r = requests.post(f"{API}/smart-contracts/{address}/verification/via/standard-input", data=data, files=files, timeout=120)
    print(f"{name:24s} {address}  submitted ({version}): {r.status_code} {r.text[:160]}")
    for _ in range(30):
        time.sleep(6)
        ok, got = status(address)
        if ok:
            print(f"{name:24s} {address}  VERIFIED as {got}")
            return True
    print(f"{name:24s} {address}  not verified yet")
    return False


if __name__ == "__main__":
    wanted = [a.lower() for a in sys.argv[1:]]
    results = [verify(a, n) for a, n in targets() if not wanted or a.lower() in wanted]
    sys.exit(0 if all(results) else 1)
