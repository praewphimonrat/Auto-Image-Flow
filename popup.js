const statusElement = document.getElementById("status");
const pingButton = document.getElementById("ping-button");

function setStatus(value) {
  statusElement.textContent = value;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs[0];
}

async function pingActiveTab() {
  try {
    const activeTab = await getActiveTab();

    if (!activeTab?.id) {
      setStatus("No active tab found.");
      return;
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "FLOW_HELPER_PING"
    });

    setStatus(JSON.stringify(response, null, 2));
  } catch (error) {
    setStatus(error.message);
  }
}

pingButton.addEventListener("click", () => {
  void pingActiveTab();
});

