
// Saves options to chrome.storage
function save_options() {
  var apiKey = document.getElementById('apiKey').value;
  var nopechaApiKey = document.getElementById('nopechaApiKey').value;
  chrome.storage.sync.set({
    'openrouter_api_key': apiKey,
    'nopecha_api_key': nopechaApiKey
  }, function() {
    // Update status to let user know options were saved.
    var status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(function() {
      status.textContent = '';
    }, 750);
  });
}

// Restores input box state using the preferences
// stored in chrome.storage.
function restore_options() {
  chrome.storage.sync.get({
    'openrouter_api_key': '',
    'nopecha_api_key': ''
  }, function(items) {
    document.getElementById('apiKey').value = items.openrouter_api_key;
    document.getElementById('nopechaApiKey').value = items.nopecha_api_key;
  });
}

document.addEventListener('DOMContentLoaded', restore_options);
document.getElementById('save').addEventListener('click', save_options);
