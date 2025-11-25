# Drools Executor

Java-based Drools runtime executor for the Monaco DRL POC.

## Prerequisites

- Java 11 or higher
- Maven 3.6+

## Building

```bash
cd java
mvn clean package
```

This will create a JAR file with all dependencies at:
`target/drools-executor-1.0.0-jar-with-dependencies.jar`

## Usage

The executor is automatically called by the Node.js server when you click "Run compile & tests" in the UI.

## Manual Testing

You can test the executor manually:

```bash
java -jar target/drools-executor-1.0.0-jar-with-dependencies.jar <base64-drl> <base64-fact-json>
```

