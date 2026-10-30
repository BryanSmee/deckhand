# Services (target)

Where the listener is headed once it is split (#499, part of #492). Today it is still one
process, beside the egress proxy: [architecture.md](architecture.md) describes what runs now.

The split follows who holds which secret and who can reach what. The only service the internet
reaches holds neither the App's key nor the Docker socket, and each secret lives in one service.

```mermaid
flowchart LR
  web(("GitHub webhooks<br/>browsers"))
  gh[("GitHub")]
  ai[("agents' APIs")]
  hosts[("granted hosts")]

  subgraph public [Public]
    edge["edge<br/>webhooks, API, UI<br/>🔑 webhook secret, session key"]
  end

  subgraph internal [Internal]
    orch["orchestrator<br/>events, tasks, queue, reviews"]
    runner["runner<br/>sandboxes, images, logs<br/>🔑 Docker socket / Kubernetes API"]
    broker["broker<br/>run and service tokens<br/>🔑 signing key"]
    github["github<br/>REST, GraphQL and git gateway<br/>🔑 App key"]
    models["models<br/>agents' API relay<br/>🔑 operator's credentials"]
    policy["policy<br/>opa, no network"]
  end

  subgraph runs ["Runs' networks"]
    sandbox["sandbox"]
    proxy["proxy<br/>egress"]
  end

  web --> edge
  edge --> orch
  edge --> github
  orch --> runner
  orch --> broker
  orch --> github
  orch --> policy
  runner -. starts .-> sandbox
  sandbox --> proxy
  proxy --> github
  proxy --> models
  proxy --> broker
  proxy --> hosts
  github --> policy
  broker --> policy
  github --> gh
  models --> ai
```

| Service      | Holds                                     | Owns (its own store)                    | Reached by                     |
| ------------ | ----------------------------------------- | --------------------------------------- | ------------------------------ |
| edge         | webhook secret, session key, OAuth client | sessions                                | the internet, browsers         |
| orchestrator | nothing secret                            | queue, waits, tasks, history, decisions | edge                           |
| runner       | Docker socket or Kubernetes API           | containers, networks, run logs          | orchestrator                   |
| broker       | the tokens' signing key                   | live runs, keys                         | orchestrator, proxy (renewals) |
| github       | the App's key, installation tokens        | each run's issues, reactions, pushes    | edge, orchestrator, proxy      |
| models       | the operator's agent credentials          | plan logins                             | proxy                          |
| policy       | nothing secret                            | nothing (reads the policy folders)      | github, orchestrator, broker   |
| proxy        | Deckhand's CA                             | the egress cache                        | sandboxes                      |

- **Runs** call through the proxy only, with their run token (#493), checked offline by each
  service. The proxy adds the network a call came from.
- **Services** call each other with a service token signed by the broker, whose `aud` names the
  service called. The network alone is never trusted.
- **No shared database**: each service keeps its own state, and streams its changes to those
  that need them (server-sent events). The broker streams run starts and ends; the orchestrator
  streams task updates to edge; the runner streams run logs.
- **The UI** stays in edge: static files from the dashboard's build, on the same origin as its
  API.
