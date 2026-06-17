import { supabase } from './supabaseClient.js'

function isRelativeUrl(value) {
    return value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|mailto:|tel:|data:)/i.test(value);
}

function resolvePageUrl(value) {
    return new URL(value, document.baseURI).href;
}

function normalizeAssetBase() {
    const rawBase = document.documentElement.dataset.assets || "assets/";
    const normalized = rawBase.replace(/^\.\//, "").replace(/\/?$/, "/");
    return normalized;
}

function rewriteUrl(value, assetBase) {
    if (!isRelativeUrl(value)) {
        return value;
    }

    if (value.includes("/")) {
        return resolvePageUrl(value);
    }

    return resolvePageUrl(assetBase + value);
}

function rewriteSrcset(value, assetBase) {
    return value
        .split(",")
        .map((candidate) => {
            const trimmed = candidate.trim();
            if (!trimmed) {
                return trimmed;
            }

            const parts = trimmed.split(/\s+/);
            parts[0] = rewriteUrl(parts[0], assetBase);
            return parts.join(" ");
        })
        .join(", ");
}

function fixPartialAssetPaths(container) {
    const assetBase = normalizeAssetBase();

    container.querySelectorAll("[src], [href], [srcset]").forEach((element) => {
        const src = element.getAttribute("src");
        if (src) {
            element.setAttribute("src", rewriteUrl(src, assetBase));
        }

        const href = element.getAttribute("href");
        if (href && element.tagName !== "A") {
            element.setAttribute("href", rewriteUrl(href, assetBase));
        }

        const srcset = element.getAttribute("srcset");
        if (srcset) {
            element.setAttribute("srcset", rewriteSrcset(srcset, assetBase));
        }
    });
}

async function loadIncludes() {
    const includeNodes = Array.from(document.querySelectorAll("[data-include]"));

    await Promise.all(includeNodes.map(async (node) => {
        const path = node.getAttribute("data-include");
        const response = await fetch(path);

        if (!response.ok) {
            throw new Error(`Failed to load ${path}`);
        }

        node.innerHTML = await response.text();
        fixPartialAssetPaths(node);
    }));
}

function reportModularStatus() {
    const includeNodes = document.querySelectorAll("[data-include]");
    const modalIds = ["arezModal", "jeanModal", "genModal", "fordModal", "amoraModal", "jersonModal", "tristanModal"];
    const missingModals = modalIds.filter((id) => !document.getElementById(id));

    if (includeNodes.length === 0 || missingModals.length > 0) {
        const messageParts = [];
        if (includeNodes.length === 0) {
            messageParts.push("No partials were found in the page.");
        }
        if (missingModals.length > 0) {
            messageParts.push(`Missing modals: ${missingModals.join(", ")}.`);
        }

        document.body.insertAdjacentHTML(
            "afterbegin",
            `<div style="padding:16px;background:#fff3cd;color:#664d03;font-family:Arial,sans-serif;">${messageParts.join(" ")} If you opened this from file://, partial loading will not work reliably.</div>`
        );
    }
}

const profileDetails = {
    arezModal: {
        name: "Arezval Loiej Angelo A. Santos",
        rows: [
            ["HIRE DATE:", "July 13, 2022"],
            ["MAIN TASK:", "Hybrid Ticket & Cashout"],
            ["OTHER TASKS:", "App Reviews"],
            ["BIRTHDAY:", "March 18, 1997"],
            ["CONTACT #:", "9106288525"],
            ["What I do:", "Managed cashout transactions by reviewing account activity and identifying potential fraud risks, provided customer support by responding to tickets and resolving issues, and monitored app store reviews by addressing customer feedback and escalating negative reviews when necessary."]
        ]
    },
    jeanModal: {
        name: "Jean-Michel Jarre Vestil",
        rows: [
            ["HIRE DATE:", "January 20, 2026"],
            ["MAIN TASK:", "Hybrid Ticket & Cashout"],
            ["OTHER TASKS:", "n/a"],
            ["BIRTHDAY:", "July 22, 1995"],
            ["CONTACT #:", "9608856258"]
        ]
    },
    genModal: {
        name: "Genevive Serrano",
        rows: [
            ["HIRE DATE:", "February 11, 2025"],
            ["MAIN TASK:", "Hybrid Ticket & Cashout"],
            ["OTHER TASKS:", "Templates"],
            ["BIRTHDAY:", "August 2, 1988"],
            ["CONTACT #:", "9178053454"]
        ]
    },
    fordModal: {
        name: "Leufard P. Vallega",
        rows: [
            ["HIRE DATE:", "January 30, 2023"],
            ["MAIN TASK:", "Tickets"],
            ["OTHER TASKS:", "Cash Out Back up"],
            ["BIRTHDAY:", "April 6, 1987"],
            ["CONTACT #:", "9435085678"],
            ["What I do:", "Reply to user's email, report patterns and issues, provide troubleshooting steps based on updates."]
        ]
    },
    amoraModal: {
        name: "Amora Angeles",
        rows: [
            ["HIRE DATE:", "July 13, 2022"],
            ["MAIN TASK:", "Tickets"],
            ["OTHER TASKS:", "Tickets Count, Back Up Cashout"],
            ["BIRTHDAY:", "November 19, 1980"],
            ["CONTACT #:", "9668933781"]
        ]
    },
    jersonModal: {
        name: "Jerson V. Gavileño",
        rows: [
            ["HIRE DATE:", "November 21, 2022"],
            ["MAIN TASK:", "CashOut"],
            ["OTHER TASKS:", "Ticket Back up"],
            ["BIRTHDAY:", "December 29, 1990"],
            ["CONTACT #:", "9668131016"],
            ["What I do:", "Fraud & Risk Analyst and creates fraud report"]
        ]
    },
    tristanModal: {
        name: "Alen Tristan Adeva",
        rows: [
            ["HIRE DATE:", "August 5, 2024"],
            ["MAIN TASK:", "CashOut"],
            ["OTHER TASKS:", "Ticket Back up"],
            ["BIRTHDAY:", "August 15, 1996"],
            ["CONTACT #:", "9760283129"]
        ]
    }
};

function ensureProfileDetails(modal) {
    const details = profileDetails[modal.id];
    const container = modal.querySelector(".profile-container");
    if (!details || !container) {
        return;
    }

    let detailsPanel = container.querySelector(".profile-details");
    if (detailsPanel && detailsPanel.textContent.trim()) {
        return;
    }

    if (!detailsPanel) {
        detailsPanel = document.createElement("div");
        detailsPanel.className = "profile-details";
        container.appendChild(detailsPanel);
    }

    const heading = document.createElement("h2");
    heading.textContent = details.name;
    detailsPanel.appendChild(heading);

    const table = document.createElement("table");
    details.rows.forEach(([label, value]) => {
        const row = document.createElement("tr");
        const labelCell = document.createElement("td");
        const valueCell = document.createElement("td");
        const strong = document.createElement("strong");

        strong.textContent = label;
        labelCell.appendChild(strong);
        valueCell.textContent = value;
        row.append(labelCell, valueCell);
        table.appendChild(row);
    });

    detailsPanel.appendChild(table);
}

function setupModals() {
    function getTrigger(node) {
        while (node && node !== document) {
            if (node.matches && node.matches("[data-modal-target], [id$='ProfileBtn']")) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    function getModalId(trigger) {
        return trigger.getAttribute("data-modal-target") || trigger.id.replace(/ProfileBtn$/, "Modal");
    }

    function openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            ensureProfileDetails(modal);
            modal.style.display = "block";
        }
    }

    function closeModal(modal) {
        if (modal) {
            modal.style.display = "none";
        }
    }

    document.addEventListener("click", (event) => {
        const trigger = getTrigger(event.target);
        if (trigger) {
            openModal(getModalId(trigger));
            return;
        }

        if (event.target.classList && event.target.classList.contains("close")) {
            closeModal(event.target.closest(".modal"));
            return;
        }

        if (event.target.classList && event.target.classList.contains("modal")) {
            closeModal(event.target);
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }

        const trigger = getTrigger(document.activeElement);
        if (!trigger) {
            return;
        }

        event.preventDefault();
        openModal(getModalId(trigger));
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    try {
        await loadIncludes();
        setupModals();
        reportModularStatus();
    } catch (error) {
        console.error(error);
        document.body.insertAdjacentHTML(
            "afterbegin",
            '<div style="padding:16px;background:#fff3cd;color:#664d03;font-family:Arial,sans-serif;">Page fragments could not load. Run this site from GitHub Pages or a local web server, not directly from file://.</div>'
        );
    }
});

