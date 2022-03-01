# 0xSplits Subgraph

## Ethereum
- Mainnet: [WIP]
- Ropsten: [WIP]

## Polygon
- Polygon: [WIP]
- Mumbai: [WIP]

### Install

```bash
yarn install
```

### Prepare

```bash
yarn prepare:${NETWORK} (mainnet, ropsten)
```

- [ handle ethereum vs polygon ABI, mappings ]
- Compiles subgraph.yaml from subgraph.template.yaml
- Generates types from schema.graphql

### Deploy

First you will need to authenticate with the proper deploy key for the given network. Or you can create your own Subgraph and deploy key for testing:

```bash
graph auth --studio ${GRAPH_API_KEY} 
# or
graph auth --hosted-servce ${GRAPH_API_KEY}
```

If you are deploying one of the official 0xSplits subgraphs:

```bash
yarn deploy:${NETWORK}
```

If you are deploying your own for testing:

```bash
graph deploy --node https://api.studio.thegraph.com/deploy/${PROJECT}
```

To check health of a deployed subgraph: 

```
curl -X POST -d '{ "query": "{indexingStatuses(subgraphs: [\"<deployment-id>\"]) {synced health fatalError {message block { number } handler } subgraph chains { chainHeadBlock { number } latestBlock { number }}}}"}' https://api.thegraph.com/index-node/graphql
```
