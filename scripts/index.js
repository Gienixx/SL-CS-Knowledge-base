function isRelativeUrl(value) {
    return value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|mailto:|tel:|data:)/i.test(value);
}

function resolvePageUrl(value) {
    return new URL(value, document.baseURI).href;
}

function fixPartialAssetPaths(container) {
    const assetBase = (document.documentElement.dataset.assets || "assets/").replace(/\/?$/, "/");

    container.querySelectorAll("[src]").forEach((element) => {
        const src = element.getAttribute("src");
        if (!isRelativeUrl(src)) {
            return;
        }

        let normalized = src;
        if (!normalized.includes("/")) {
            normalized = assetBase + normalized;
        }

        element.setAttribute("src", resolvePageUrl(normalized));
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

function setupModals() {
    const modalTriggers = document.querySelectorAll("[data-modal-target]");

    modalTriggers.forEach((trigger) => {
        trigger.addEventListener("click", () => {
            const modal = document.getElementById(trigger.getAttribute("data-modal-target"));
            if (modal) {
                modal.style.display = "block";
            }
        });
    });

    document.querySelectorAll(".modal").forEach((modal) => {
        const closeButton = modal.querySelector(".close");

        if (closeButton) {
            closeButton.addEventListener("click", () => {
                modal.style.display = "none";
            });
        }

        modal.addEventListener("click", (event) => {
            if (event.target === modal) {
                modal.style.display = "none";
            }
        });
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    try {
        await loadIncludes();
        setupModals();
    } catch (error) {
        console.error(error);
        document.body.insertAdjacentHTML(
            "afterbegin",
            '<div style="padding:16px;background:#fff3cd;color:#664d03;font-family:Arial,sans-serif;">Page fragments could not load. Run this site from GitHub Pages or a local web server, not directly from file://.</div>'
        );
    }
});
