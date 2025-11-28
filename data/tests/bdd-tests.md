# BDD Test Cases - Card Authorization Compliance Rules

## Geolocation Compliance Rules

### Scenario: Block transactions from Crimea
- **Given** a card authorization request from Crimea region (Sevastopol or Simferopol)
- **When** the transaction is processed
- **Then** the transaction should be declined
- **And** the decline reason should indicate "Restricted geolocation (Crimea)"
- **And** the risk score should be set to 100
- **And** the transaction should be marked as high risk

### Scenario: Block transactions from North Korea
- **Given** a card authorization request from North Korea (country code "KP")
- **When** the transaction is processed
- **Then** the transaction should be declined
- **And** the decline reason should indicate "Restricted geolocation (North Korea)"
- **And** the risk score should be set to 100

## Device Profile Security Rules

### Scenario: Flag rooted/jailbroken devices
- **Given** a card authorization request from a rooted or jailbroken device
- **When** the transaction is processed
- **Then** the risk score should increase by 30 points
- **And** the transaction should require manual review

### Scenario: Flag emulator devices
- **Given** a card authorization request from an emulator device
- **When** the transaction is processed
- **Then** the risk score should increase by 25 points
- **And** the transaction should require manual review

### Scenario: Block high risk device combination
- **Given** a card authorization request from a device that is both rooted and an emulator
- **When** the transaction is processed
- **Then** the transaction should be declined
- **And** the decline reason should indicate "High risk device profile (rooted + emulator)"
- **And** the risk score should be set to 100

## Transaction Amount Rules

### Scenario: Require review for large transactions
- **Given** a card authorization request with amount greater than $10,000 USD
- **When** the transaction is processed
- **Then** the risk score should increase by 20 points
- **And** the transaction should require manual review

## Merchant Category Rules

### Scenario: Flag high risk merchant categories
- **Given** a card authorization request from a high risk merchant category (GAMBLING, ADULT_CONTENT, or CRYPTO_CURRENCY)
- **When** the transaction is processed
- **Then** the risk score should increase by 15 points
- **And** the transaction should require manual review

## Cross-Border Transaction Rules

### Scenario: Flag high value cross-border transactions
- **Given** a card authorization request where issuer country differs from merchant country
- **And** the transaction amount is greater than $5,000
- **When** the transaction is processed
- **Then** the risk score should increase by 25 points
- **And** the transaction should require manual review

## Auto-Authorization Rules

### Scenario: Auto-authorize low risk transactions
- **Given** a card authorization request with risk score less than 30
- **And** the transaction is not already declined
- **And** the transaction is not marked as high risk
- **When** the transaction is processed
- **Then** the transaction should be automatically authorized

## High Risk Decline Rules

### Scenario: Decline high risk transactions
- **Given** a card authorization request with risk score of 70 or higher
- **And** the transaction is not already authorized
- **When** the transaction is processed
- **Then** the transaction should be declined
- **And** the decline reason should indicate the high risk score
- **And** the transaction should be marked as high risk
