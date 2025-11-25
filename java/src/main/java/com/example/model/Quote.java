package com.example.model;

public class Quote {
    private boolean loyalCustomer;
    private double premium;
    private double discount;
    private boolean requiresReview;

    public Quote() {
    }

    public Quote(boolean loyalCustomer, double premium, double discount, boolean requiresReview) {
        this.loyalCustomer = loyalCustomer;
        this.premium = premium;
        this.discount = discount;
        this.requiresReview = requiresReview;
    }

    public boolean isLoyalCustomer() {
        return loyalCustomer;
    }

    public void setLoyalCustomer(boolean loyalCustomer) {
        this.loyalCustomer = loyalCustomer;
    }

    public double getPremium() {
        return premium;
    }

    public void setPremium(double premium) {
        this.premium = premium;
    }

    public double getDiscount() {
        return discount;
    }

    public void setDiscount(double discount) {
        this.discount = discount;
    }

    public boolean isRequiresReview() {
        return requiresReview;
    }

    public void setRequiresReview(boolean requiresReview) {
        this.requiresReview = requiresReview;
    }
}

