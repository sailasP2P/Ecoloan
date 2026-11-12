
"use strict";

/*
  Independent Loan Service
  Browser-side application workflow.

  This file does not generate or store verification codes.
  Verification codes must be generated and checked by the server.
*/

const API = "/api";

const $ = (id) => document.getElementById(id);

function readData(key, fallback = "") {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveData(key, value) {
  sessionStorage.setItem(key, String(value));
}

function getApplication() {
  return {
    id: readData("applicationId"),
    token: readData("applicationToken")
  };
}

function formatMoney(value) {
  return "KSh " + Number(value).toLocaleString("en-KE");
}

function showStatus(id, message) {
  const element = $(id);
  if (element) element.textContent = message;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(result.message || "Something went wrong. Please try again.");
  }

  return result;
}

function goTo(page) {
  window.location.href = page;
}

function getFormData() {
  return {
    amount: Number(readData("loanAmount", "5000")),
    term: Number(readData("loanTerm", "3")),
    purpose: readData("loanPurpose"),
    purposeDetails: readData("purposeDetails"),
    firstName: readData("firstName"),
    lastName: readData("lastName"),
    email: readData("email"),
    phone: readData("phone")
  };
}

/* PAGE 1: Choose loan amount */

const amount = $("amount");
const term = $("term");

function updateLoanValues() {
  if (amount) {
    $("amountValue").textContent = formatMoney(amount.value);
    saveData("loanAmount", amount.value);
  }

  if (term) {
    $("termValue").textContent =
      term.value + (Number(term.value) === 1 ? " month" : " months");

    saveData("loanTerm", term.value);
  }
}

if (amount) {
  amount.value = readData("loanAmount", "5000");
  amount.addEventListener("input", updateLoanValues);
}

if (term) {
  term.value = readData("loanTerm", "3");
  term.addEventListener("input", updateLoanValues);
}

updateLoanValues();

if ($("loanNext")) {
  $("loanNext").addEventListener("click", () => {
    goTo("purpose.html");
  });
}

/* PAGE 2: Loan purpose */

if ($("purpose")) {
  $("purpose").value = readData("loanPurpose");
}

if ($("purposeDetails")) {
  $("purposeDetails").value = readData("purposeDetails");
}

if ($("purposeNext")) {
  $("purposeNext").addEventListener("click", () => {
    const purpose = $("purpose").value;
    const details = $("purposeDetails").value.trim();

    if (!purpose) {
      alert("Please select your loan purpose.");
      return;
    }

    saveData("loanPurpose", purpose);
    saveData("purposeDetails", details);

    goTo("details.html");
  });
}

/* PAGE 3: Applicant details */

["firstName", "lastName", "email", "phone"].forEach((id) => {
  if ($(id)) $(id).value = readData(id);
});

if ($("detailsNext")) {
  $("detailsNext").addEventListener("click", () => {
    const firstName = $("firstName").value.trim();
    const lastName = $("lastName").value.trim();
    const email = $("email").value.trim();
    const phone = $("phone").value.trim();

    if (!firstName || !lastName || !email || !phone) {
      alert("Please complete all the required fields.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert("Please enter a valid email address.");
      return;
    }

    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      alert("Enter your phone number in international format, for example +2547XXXXXXXX.");
      return;
    }

    saveData("firstName", firstName);
    saveData("lastName", lastName);
    saveData("email", email);
    saveData("phone", phone);

    goTo("summary.html");
  });
}

/* PAGE 4: Application summary */

if ($("summaryAmount")) {
  const data = getFormData();

  $("summaryAmount").textContent = formatMoney(data.amount);
  $("summaryTerm").textContent =
    data.term + (data.term === 1 ? " month" : " months");
  $("summaryPurpose").textContent = data.purpose || "—";
  $("summaryPurposeDetails").textContent = data.purposeDetails || "—";
  $("summaryName").textContent =
    (data.firstName + " " + data.lastName).trim() || "—";
  $("summaryEmail").textContent = data.email || "—";
  $("summaryPhone").textContent = data.phone || "—";
}

/* PAGE 5: Submit application */

if ($("submitApplication")) {
  $("submitApplication").addEventListener("click", () => {
    if (!$("agreeTerms").checked) {
      alert("Please confirm that you have read the terms and privacy notice.");
      return;
    }

    goTo("submitting.html");
  });
}

/* PAGE 6: Send application to the server */

if (document.querySelector('[data-page="submitting"]')) {
  (async () => {
    try {
      const data = getFormData();

      const result = await apiRequest("/applications", {
        method: "POST",
        body: JSON.stringify(data)
      });

      if (!result.applicationId || !result.applicationToken) {
        throw new Error("The server returned an incomplete application response.");
      }

      saveData("applicationId", result.applicationId);
      saveData("applicationToken", result.applicationToken);

      goTo("verify-application.html");
    } catch (error) {
      showStatus("submitStatus", error.message);
    }
  })();
}

/* PAGE 7: Verify the first application code */

if ($("verifyApplication")) {
  $("verifyApplication").addEventListener("click", async () => {
    const code = $("applicationCode").value.trim();
    const app = getApplication();

    if (!/^\d{4}$/.test(code)) {
      showStatus("verificationStatus", "Enter the 4-digit code.");
      return;
    }

    if (!app.id || !app.token) {
      showStatus("verificationStatus", "Application session not found. Please contact support.");
      return;
    }

    try {
      $("verifyApplication").disabled = true;

      await apiRequest("/applications/verify", {
        method: "POST",
        body: JSON.stringify({
          applicationId: app.id,
          applicationToken: app.token,
          code
        })
      });

      goTo("awaiting-admin.html");
    } catch (error) {
      showStatus("verificationStatus", error.message);
      $("verifyApplication").disabled = false;
    }
  });
}

/* PAGE 8: Wait for administrator decision */

if (document.querySelector('[data-page="awaiting-admin"]')) {
  const app = getApplication();

  if (!app.id || !app.token) {
    showStatus("adminStatus", "Application session not found. Please contact support.");
  } else {
    let checking = false;

    async function checkAdminStatus() {
      if (checking) return;
      checking = true;

      try {
        const result = await apiRequest(
          "/applications/status?applicationId=" + encodeURIComponent(app.id),
          {
            headers: {
              Authorization: "Bearer " + app.token
            }
          }
        );

        if (result.status === "approved") {
          goTo("verify-final.html");
          return;
        }

        if (result.status === "rejected") {
          goTo("rejected.html");
          return;
        }

        showStatus("adminStatus", "Your application is still awaiting review.");
      } catch (error) {
        showStatus("adminStatus", "Unable to check status right now. Please keep this page open.");
      } finally {
        checking = false;
      }
    }

    checkAdminStatus();
    window.setInterval(checkAdminStatus, 10000);
  }
}

/* PAGE 9: Final verification code */

if ($("verifyFinal")) {
  $("verifyFinal").addEventListener("click", async () => {
    const code = $("finalCode").value.trim();
    const app = getApplication();

    if (!/^\d{6}$/.test(code)) {
      showStatus("finalStatus", "Enter the 6-digit code.");
      return;
    }

    try {
      $("verifyFinal").disabled = true;

      await apiRequest("/applications/verify-final", {
        method: "POST",
        body: JSON.stringify({
          applicationId: app.id,
          applicationToken: app.token,
          code
        })
      });

      goTo("success.html");
    } catch (error) {
      showStatus("finalStatus", error.message);
      $("verifyFinal").disabled = false;
    }
  });
}

/* Resend final verification code */

if ($("resendFinalCode")) {
  $("resendFinalCode").addEventListener("click", async () => {
    const app = getApplication();

    try {
      $("resendFinalCode").disabled = true;

      const result = await apiRequest("/applications/resend-final", {
        method: "POST",
        body: JSON.stringify({
          applicationId: app.id,
          applicationToken: app.token
        })
      });

      showStatus("finalStatus", result.message || "A new code has been requested.");
    } catch (error) {
      showStatus("finalStatus", error.message);
    } finally {
      $("resendFinalCode").disabled = false;
    }
  });
    }
      
