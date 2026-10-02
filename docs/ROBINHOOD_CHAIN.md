# Robinhood Chain — reference for this project

Robinhood Chain is an Arbitrum Orbit (Nitro) L2 settling to Ethereum. Gas is paid in ETH,
block time ~100 ms, fully EVM-compatible (Solidity, Foundry, viem/wagmi, MetaMask work as-is).
Arbitrum precompiles (ArbSys, ArbGasInfo, ...) are available. Transaction fees have an L2
execution component plus an L1 data component, so `gasleft()`/estimates differ from L1.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | `4663` | `46630` |
| Name | Robinhood Chain | Robinhood Chain Testnet |
| Native currency | ETH (18) | Sepolia ETH (18) |
| Official RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com/rpc` |
| Public RPCs | `https://robinhood-rpc.publicnode.com`, `wss://robinhood-rpc.publicnode.com`, `https://robinhood.drpc.org`, `wss://robinhood.drpc.org`, `https://rpc.arrowrpc.com`, `https://rpc.ordofi.network` | `https://robinhood-sepolia-rpc.publicnode.com`, `wss://robinhood-sepolia-rpc.publicnode.com`, `https://robinhood-testnet.drpc.org`, `wss://robinhood-testnet.drpc.org` |
| Explorer (Blockscout) | `https://robinhoodchain.blockscout.com` (also `https://robinscan.io`, `https://hoodscan.co`, `https://stonkscan.io`) | `https://explorer.testnet.chain.robinhood.com` |
| Blockscout API (verification) | `https://robinhoodchain.blockscout.com/api` | `https://explorer.testnet.chain.robinhood.com/api` |
| Parent chain | Ethereum (1) | Sepolia (11155111) |
| Bridge | `https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum` | `https://portal.arbitrum.io/bridge` |
| Faucets | — | `https://faucet.testnet.chain.robinhood.com`, `https://faucet.quicknode.com/robinhood/testnet`, Chainstack / Alchemy multi-chain faucets |
| Docs | `https://docs.robinhood.com/chain` | same |

Source: `ethereum-lists/chains` (`eip155-4663.json`, `eip155-46630.json`), Uniswap
`contracts/deployments/4663.md`, Robinhood docs.

## Mainnet (4663) protocol addresses

| Contract | Address |
|---|---|
| WETH9 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V3 Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| Uniswap V3 NonfungiblePositionManager | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| Uniswap V3 SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| Uniswap V3 QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| Uniswap V3 TickLens | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` |
| Uniswap V3 pool init code hash | `0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54` |
| Uniswap V2 Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` |
| Uniswap V2 Router02 | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` |
| Uniswap V2 pair init code hash | `0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f` |
| Uniswap V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Uniswap V4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| Uniswap V4 Quoter / StateView | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` / `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Universal Router (v2.1.2) | `0x204FAca1764B154221e35c0d20aBb3c525710498` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Uniswap Interface Multicall | `0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3` |

Chainlink Data Feeds are live on Robinhood Chain mainnet (Chainlink is the chain's oracle
partner). The ETH/USD feed address is **not** hard-coded here: set `ETH_USD_FEED` in the runner
env once you confirm it from `data.chain.link`, otherwise the runner uses `ETH_USD_PRICE`.

## Testnet (46630)

| Contract | Address |
|---|---|
| WETH9 | `0x7943e237c7F95DA44E0301572D358911207852Fa` |
| Uniswap V3 | no public deployment list found for 46630 — use `MockGraduator` or set your own addresses |

## Wallet config (EIP-3085)

```json
{
  "chainId": "0x1237",
  "chainName": "Robinhood Chain",
  "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
  "rpcUrls": ["https://rpc.mainnet.chain.robinhood.com"],
  "blockExplorerUrls": ["https://robinhoodchain.blockscout.com"]
}
```

Testnet: `chainId` `0xb626` (46630), rpc `https://rpc.testnet.chain.robinhood.com/rpc`,
explorer `https://explorer.testnet.chain.robinhood.com`.

## Foundry

```toml
[rpc_endpoints]
robinhood = "${ROBINHOOD_RPC_URL}"
robinhood_testnet = "${ROBINHOOD_TESTNET_RPC_URL}"

[etherscan]
robinhood = { key = "${BLOCKSCOUT_API_KEY}", url = "https://robinhoodchain.blockscout.com/api", chain = 4663 }
robinhood_testnet = { key = "${BLOCKSCOUT_API_KEY}", url = "https://explorer.testnet.chain.robinhood.com/api", chain = 46630 }
```

Verify with `forge verify-contract --verifier blockscout --verifier-url <api url> <address> <Contract>`.
