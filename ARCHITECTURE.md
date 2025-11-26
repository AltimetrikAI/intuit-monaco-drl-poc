# Production Architecture Diagram

## High-Level Overview

This system provides an **AI-powered code completion service for Drools Rule Language (DRL)** using a Language Server Protocol (LSP) architecture. The solution enables intelligent, context-aware code suggestions in a Monaco-based web editor by leveraging Large Language Models (LLMs) to understand business rules, fact objects, and BDD test scenarios.

### Core Concept

When a developer types in the DRL editor, the system:
1. **Detects** trigger characters (`.`, `(`, `:`, `=`) that indicate code completion opportunities
2. **Analyzes** the current code context, fact object schema, and BDD test scenarios
3. **Generates** intelligent completion suggestions using an LLM (GPT-4o-mini)
4. **Displays** contextually relevant suggestions in real-time within the editor

### Key Components

- **Monaco Editor**: Web-based code editor with LSP client integration
- **LSP Server**: WebSocket-based language server that orchestrates completion generation
- **LLM Integration**: OpenAI API for generating context-aware code completions
- **Backend API**: RESTful service for rule management, compilation, and testing
- **Drools Runtime**: Java-based rule engine for actual rule execution and validation

### Production Architecture Principles

- **Stateless LSP Servers**: Horizontally scalable WebSocket servers
- **Real-time Communication**: WebSocket connections for low-latency completion delivery
- **Context-Aware**: Leverages fact objects and BDD tests for intelligent suggestions
- **Scalable**: Designed for cloud deployment with load balancing and caching

## System Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        Browser[Browser]
        Monaco[Monaco Editor<br/>DRL Code Editor]
        React[React App<br/>UI Components]
    end

    subgraph "Frontend Server"
        Vite[Vite Dev Server<br/>:5173]
    end

    subgraph "Backend Services"
        API[Express API Server<br/>:4000<br/>REST Endpoints]
        LSP[LSP WebSocket Server<br/>:4001<br/>Language Server]
    end

    subgraph "External Services"
        OpenAI[OpenAI API<br/>GPT-4o-mini<br/>Code Completions]
    end

    subgraph "Data Layer"
        Files[File System<br/>DRL Rules<br/>Fact Objects<br/>BDD Tests]
        JavaRuntime[Java Drools Runtime<br/>Maven JAR<br/>Rule Execution]
    end

    subgraph "LSP Communication Flow"
        WS[WebSocket Connection<br/>Real-time Communication]
    end

    %% Client connections
    Browser --> Monaco
    Browser --> React
    React --> Vite
    Vite --> API

    %% LSP connections
    Monaco -.->|WebSocket| WS
    WS --> LSP

    %% API connections
    API --> Files
    API --> JavaRuntime

    %% LSP to external services
    LSP -->|LLM API Calls| OpenAI
    LSP -->|Read Context| Files

    %% Data flow annotations
    Monaco -.->|1. User Types| WS
    WS -.->|2. Document Updates| LSP
    LSP -.->|3. Analyze Context| Files
    LSP -.->|4. Generate Completions| OpenAI
    OpenAI -.->|5. Return Suggestions| LSP
    LSP -.->|6. Send Completions| WS
    WS -.->|7. Display in Editor| Monaco

    style Browser fill:#e1f5ff
    style Monaco fill:#fff4e1
    style LSP fill:#e8f5e9
    style OpenAI fill:#f3e5f5
    style API fill:#fff9c4
    style Files fill:#fce4ec
    style JavaRuntime fill:#e0f2f1
```

## Detailed Component Flow

```mermaid
sequenceDiagram
    participant User
    participant Monaco as Monaco Editor
    participant Client as LSP Client<br/>(Browser)
    participant LSP as LSP Server<br/>(WebSocket)
    participant OpenAI as OpenAI API
    participant Files as File System
    participant API as Express API

    Note over User,API: Initialization Phase
    User->>Monaco: Opens DRL Editor
    Monaco->>Client: Editor Mounted
    Client->>LSP: WebSocket Connect
    Client->>API: GET /api/fact
    API-->>Client: Fact Object JSON
    Client->>API: GET /api/bdd
    API-->>Client: BDD Tests
    Client->>LSP: initialize/context<br/>(factObject, bddTests, schema)
    LSP-->>Client: Initialization Confirmed

    Note over User,API: Code Completion Flow
    User->>Monaco: Types "." (trigger)
    Monaco->>Client: Document Change Event
    Client->>LSP: textDocument/didChange<br/>(full document content)
    LSP->>LSP: Analyze Change<br/>Detect Trigger Character
    LSP->>LSP: Parse Context<br/>(position, surrounding code)
    LSP->>Files: Read Fact Schema<br/>(already cached)
    LSP->>OpenAI: Chat Completion Request<br/>(prompt with context)
    OpenAI-->>LSP: JSON Array of Completions
    LSP->>LSP: Parse & Format Completions
    LSP->>Client: completions/available<br/>(proactive notification)
    Client->>Monaco: Trigger Suggestion Widget
    Client->>Monaco: provideCompletionItems<br/>(return stored completions)
    Monaco-->>User: Display Completion List

    Note over User,API: Rule Execution Flow
    User->>Monaco: Clicks "Run compile & tests"
    Monaco->>API: POST /api/run<br/>(DRL content)
    API->>JavaRuntime: Execute Drools Rules<br/>(compile & test)
    JavaRuntime-->>API: Results (logs, fired rules)
    API-->>Monaco: Pipeline Result JSON
    Monaco-->>User: Display Status Panel
```

## Production Deployment Architecture

```mermaid
graph LR
    subgraph "User's Browser"
        Browser[Browser]
    end

    subgraph "CDN / Edge"
        CDN[CDN<br/>Static Assets]
    end

    subgraph "Load Balancer"
        LB[Load Balancer<br/>HTTPS :443]
    end

    subgraph "Frontend Cluster"
        FE1[Frontend Server 1<br/>React App]
        FE2[Frontend Server 2<br/>React App]
        FE3[Frontend Server N<br/>React App]
    end

    subgraph "API Cluster"
        API1[API Server 1<br/>Express :4000]
        API2[API Server 2<br/>Express :4000]
        APIN[API Server N<br/>Express :4000]
    end

    subgraph "LSP Cluster"
        LSP1[LSP Server 1<br/>WebSocket :4001]
        LSP2[LSP Server 2<br/>WebSocket :4001]
        LSPN[LSP Server N<br/>WebSocket :4001]
        LSPLB[LSP Load Balancer<br/>WebSocket Routing]
    end

    subgraph "External Services"
        OpenAI[OpenAI API<br/>GPT-4o-mini]
    end

    subgraph "Data Layer"
        Storage[Object Storage<br/>S3 / GCS<br/>DRL Files, Facts, BDD]
        Cache[Redis Cache<br/>Session State<br/>Fact Objects]
        DB[(Database<br/>Rule Metadata)]
    end

    subgraph "Compute Layer"
        Java[Kubernetes Pods<br/>Drools Runtime<br/>Java Executors]
    end

    Browser -->|HTTPS| LB
    LB --> FE1
    LB --> FE2
    LB --> FE3
    FE1 -->|WebSocket| LSPLB
    FE2 -->|WebSocket| LSPLB
    FE3 -->|WebSocket| LSPLB
    LSPLB --> LSP1
    LSPLB --> LSP2
    LSPLB --> LSPN
    FE1 -->|REST API| API1
    FE2 -->|REST API| API2
    FE3 -->|REST API| APIN
    API1 --> Storage
    API2 --> Storage
    APIN --> Storage
    API1 --> Cache
    API2 --> Cache
    APIN --> Cache
    API1 --> DB
    API2 --> DB
    APIN --> DB
    API1 --> Java
    API2 --> Java
    APIN --> Java
    LSP1 --> OpenAI
    LSP2 --> OpenAI
    LSPN --> OpenAI
    LSP1 --> Cache
    LSP2 --> Cache
    LSPN --> Cache
    CDN --> Browser

    style Browser fill:#e1f5ff
    style LSP1 fill:#e8f5e9
    style LSP2 fill:#e8f5e9
    style LSPN fill:#e8f5e9
    style OpenAI fill:#f3e5f5
    style Storage fill:#fce4ec
    style Cache fill:#fff9c4
```

## Key Production Considerations

### Scalability
- **LSP Servers**: Stateless, can scale horizontally
- **Session Management**: Use Redis for WebSocket session state
- **Load Balancing**: WebSocket sticky sessions for LSP connections

### Security
- **API Keys**: Stored in secure secret management (AWS Secrets Manager, etc.)
- **HTTPS/WSS**: All connections encrypted
- **Rate Limiting**: Per-user limits on LLM API calls
- **Authentication**: User authentication before LSP connection

### Performance
- **Caching**: Fact objects and BDD tests cached in Redis
- **Connection Pooling**: Reuse OpenAI API connections
- **Async Processing**: Non-blocking LLM calls
- **CDN**: Static assets served from edge locations

### Monitoring
- **Metrics**: Completion latency, LLM API usage, error rates
- **Logging**: Centralized logging (ELK, CloudWatch, etc.)
- **Alerting**: Monitor LLM API failures, high latency

