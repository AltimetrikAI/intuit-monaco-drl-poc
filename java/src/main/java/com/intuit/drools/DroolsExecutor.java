package com.intuit.drools;

import com.example.model.CardAuthorizationRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.kie.api.KieServices;
import org.kie.api.builder.KieBuilder;
import org.kie.api.builder.KieFileSystem;
import org.kie.api.builder.KieRepository;
import org.kie.api.builder.Message;
import org.kie.api.runtime.KieContainer;
import org.kie.api.runtime.KieSession;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

public class DroolsExecutor {
    private static final ObjectMapper mapper = new ObjectMapper();

    public static void main(String[] args) {
        if (args.length < 2) {
            System.err.println("Usage: DroolsExecutor <drl-content-base64> <fact-json-base64>");
            System.exit(1);
        }

        // Decode base64 inputs
        String drlContent = new String(Base64.getDecoder().decode(args[0]));
        String factJson = new String(Base64.getDecoder().decode(args[1]));

        try {
            Result result = executeRules(drlContent, factJson);
            System.out.println(mapper.writeValueAsString(result));
        } catch (Exception e) {
            System.err.println("Error: " + e.getMessage());
            e.printStackTrace();
            System.exit(1);
        }
    }

    public static Result executeRules(String drlContent, String factJson) throws Exception {
        Result result = new Result();
        List<String> errors = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        List<String> firedRules = new ArrayList<>();
        CardAuthorizationRequest request = null;

        try {
            // Parse fact JSON
            System.out.println("[Drools Executor] Parsing fact JSON...");
            request = mapper.readValue(factJson, CardAuthorizationRequest.class);
            System.out.println("[Drools Executor] Fact parsed: transactionId=" + request.getTransactionId() + 
                             ", amount=" + request.getAmount() + ", merchantCountry=" + request.getMerchantCountry() +
                             ", isRooted=" + request.isRooted() + ", isEmulator=" + request.isEmulator());
        } catch (Exception e) {
            errors.add("Failed to parse fact JSON: " + e.getMessage());
            result.errors = errors;
            result.status = "failed";
            return result;
        }

        try {
            // Create KieServices
            System.out.println("[Drools Executor] Initializing Drools KieServices...");
            KieServices kieServices = KieServices.Factory.get();
            KieFileSystem kfs = kieServices.newKieFileSystem();

            // Add DRL content with a proper path
            System.out.println("[Drools Executor] Writing DRL content to KieFileSystem...");
            kfs.write("src/main/resources/rules.drl", drlContent);

            // Build the knowledge base
            System.out.println("[Drools Executor] Compiling DRL rules...");
            KieBuilder kieBuilder = kieServices.newKieBuilder(kfs).buildAll();
            System.out.println("[Drools Executor] Compilation complete.");

            // Check for compilation errors
            if (kieBuilder.getResults().hasMessages(Message.Level.ERROR)) {
                for (Message message : kieBuilder.getResults().getMessages(Message.Level.ERROR)) {
                    errors.add(message.getText());
                }
                result.errors = errors;
                result.status = "failed";
                return result;
            }

            // Check for warnings
            for (Message message : kieBuilder.getResults().getMessages(Message.Level.WARNING)) {
                warnings.add(message.getText());
            }

            // Get the release ID from the built module
            org.kie.api.builder.ReleaseId releaseId = kieBuilder.getKieModule().getReleaseId();
            
            // Create KieContainer and KieSession
            System.out.println("[Drools Executor] Creating KieContainer and KieSession...");
            KieContainer kieContainer = kieServices.newKieContainer(releaseId);
            KieSession kieSession = kieContainer.newKieSession();

            // Note: Drools rules can use System.out.println which we'll capture via stdout

            // Insert fact
            System.out.println("[Drools Executor] Inserting fact into working memory...");
            kieSession.insert(request);

            // Fire rules
            System.out.println("[Drools Executor] Firing all rules...");
            int fired = kieSession.fireAllRules();
            System.out.println("[Drools Executor] Rules execution complete. Fired " + fired + " rule(s).");
            firedRules.add("Fired " + fired + " rule(s)");

            // Get updated request state
            result.factAfter = mapper.writeValueAsString(request);
            result.firedCount = fired;
            
            System.out.println("[Drools Executor] Final fact state: isAuthorized=" + request.isAuthorized() + 
                             ", riskScore=" + request.getRiskScore() + ", requiresManualReview=" + 
                             request.isRequiresManualReview() + ", declineReason=" + request.getDeclineReason());

            kieSession.dispose();
            System.out.println("[Drools Executor] Session disposed. Execution successful.");

            result.status = errors.isEmpty() ? "passed" : "failed";
            result.errors = errors;
            result.warnings = warnings;
            result.firedRules = firedRules;

        } catch (Exception e) {
            System.err.println("[Drools Executor] ERROR: " + e.getMessage());
            e.printStackTrace();
            errors.add("Drools execution error: " + e.getMessage());
            result.errors = errors;
            result.status = "failed";
        }

        return result;
    }

    public static class Result {
        public String status;
        public List<String> errors = new ArrayList<>();
        public List<String> warnings = new ArrayList<>();
        public List<String> firedRules = new ArrayList<>();
        public String factAfter;
        public int firedCount;
    }
}

