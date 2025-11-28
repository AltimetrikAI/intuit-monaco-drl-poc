package com.example.model;

import com.fasterxml.jackson.annotation.JsonProperty;

public class CardAuthorizationRequest {
    private String transactionId;
    private double amount;
    private String currency;
    private String merchantCategory;
    private String cardType;
    private String issuerCountry;
    private String merchantCountry;
    private String merchantRegion;
    private String merchantCity;
    private String deviceType;
    private String osVersion;
    private boolean isRooted;
    private boolean isEmulator;
    private String ipAddress;
    private boolean isAuthorized;
    private String declineReason;
    private int riskScore;
    private boolean requiresManualReview;
    private boolean isHighRiskTransaction;

    public CardAuthorizationRequest() {
    }

    public CardAuthorizationRequest(String transactionId, double amount, String currency, 
                                   String merchantCategory, String cardType, String issuerCountry,
                                   String merchantCountry, String merchantRegion, String merchantCity,
                                   String deviceType, String osVersion, boolean isRooted, 
                                   boolean isEmulator, String ipAddress) {
        this.transactionId = transactionId;
        this.amount = amount;
        this.currency = currency;
        this.merchantCategory = merchantCategory;
        this.cardType = cardType;
        this.issuerCountry = issuerCountry;
        this.merchantCountry = merchantCountry;
        this.merchantRegion = merchantRegion;
        this.merchantCity = merchantCity;
        this.deviceType = deviceType;
        this.osVersion = osVersion;
        this.isRooted = isRooted;
        this.isEmulator = isEmulator;
        this.ipAddress = ipAddress;
        this.isAuthorized = false;
        this.riskScore = 0;
        this.requiresManualReview = false;
        this.isHighRiskTransaction = false;
    }

    // Getters and Setters
    public String getTransactionId() {
        return transactionId;
    }

    public void setTransactionId(String transactionId) {
        this.transactionId = transactionId;
    }

    public double getAmount() {
        return amount;
    }

    public void setAmount(double amount) {
        this.amount = amount;
    }

    public String getCurrency() {
        return currency;
    }

    public void setCurrency(String currency) {
        this.currency = currency;
    }

    public String getMerchantCategory() {
        return merchantCategory;
    }

    public void setMerchantCategory(String merchantCategory) {
        this.merchantCategory = merchantCategory;
    }

    public String getCardType() {
        return cardType;
    }

    public void setCardType(String cardType) {
        this.cardType = cardType;
    }

    public String getIssuerCountry() {
        return issuerCountry;
    }

    public void setIssuerCountry(String issuerCountry) {
        this.issuerCountry = issuerCountry;
    }

    public String getMerchantCountry() {
        return merchantCountry;
    }

    public void setMerchantCountry(String merchantCountry) {
        this.merchantCountry = merchantCountry;
    }

    public String getMerchantRegion() {
        return merchantRegion;
    }

    public void setMerchantRegion(String merchantRegion) {
        this.merchantRegion = merchantRegion;
    }

    public String getMerchantCity() {
        return merchantCity;
    }

    public void setMerchantCity(String merchantCity) {
        this.merchantCity = merchantCity;
    }

    public String getDeviceType() {
        return deviceType;
    }

    public void setDeviceType(String deviceType) {
        this.deviceType = deviceType;
    }

    public String getOsVersion() {
        return osVersion;
    }

    public void setOsVersion(String osVersion) {
        this.osVersion = osVersion;
    }

    @JsonProperty("isRooted")
    public boolean isRooted() {
        return isRooted;
    }

    @JsonProperty("isRooted")
    public void setRooted(boolean rooted) {
        isRooted = rooted;
    }

    // Additional getter for Drools/MVEL property access (without "is" prefix)
    public boolean getRooted() {
        return isRooted;
    }

    @JsonProperty("isEmulator")
    public boolean isEmulator() {
        return isEmulator;
    }

    @JsonProperty("isEmulator")
    public void setEmulator(boolean emulator) {
        isEmulator = emulator;
    }

    // Additional getter for Drools/MVEL property access (without "is" prefix)
    public boolean getEmulator() {
        return isEmulator;
    }

    public String getIpAddress() {
        return ipAddress;
    }

    public void setIpAddress(String ipAddress) {
        this.ipAddress = ipAddress;
    }

    @JsonProperty("isAuthorized")
    public boolean isAuthorized() {
        return isAuthorized;
    }

    @JsonProperty("isAuthorized")
    public void setAuthorized(boolean authorized) {
        isAuthorized = authorized;
    }

    // Additional getter for Drools/MVEL property access (without "is" prefix)
    public boolean getAuthorized() {
        return isAuthorized;
    }

    public String getDeclineReason() {
        return declineReason;
    }

    public void setDeclineReason(String declineReason) {
        this.declineReason = declineReason;
    }

    public int getRiskScore() {
        return riskScore;
    }

    public void setRiskScore(int riskScore) {
        this.riskScore = riskScore;
    }

    public boolean isRequiresManualReview() {
        return requiresManualReview;
    }

    public void setRequiresManualReview(boolean requiresManualReview) {
        this.requiresManualReview = requiresManualReview;
    }

    @JsonProperty("isHighRiskTransaction")
    public boolean isHighRiskTransaction() {
        return isHighRiskTransaction;
    }

    @JsonProperty("isHighRiskTransaction")
    public void setHighRiskTransaction(boolean highRiskTransaction) {
        isHighRiskTransaction = highRiskTransaction;
    }

    // Additional getter for Drools/MVEL property access (without "is" prefix)
    public boolean getHighRiskTransaction() {
        return isHighRiskTransaction;
    }
}

