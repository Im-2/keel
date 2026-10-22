# Notice

`contracts/` is built on top of the MUSD protocol by Mezo / Thesis (https://github.com/mezo-org/musd), GPL-3.0.
Everything under `contracts/contracts/` except `keel/` and `contracts/test/` (tester contracts) is Mezo's code,
vendored unmodified so Keel's integration tests run against the real protocol. Keel's own contracts live in
`contracts/contracts/keel/` and are also GPL-3.0.
