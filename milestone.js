// ============================================================
// milestone.js — Milestone Management for GitLab Task Tracker
// ============================================================

// --- GitLab Token Management (same as app.js) ---
let GITLAB_TOKEN = localStorage.getItem('gitlab_token_v3') || '';
if (!GITLAB_TOKEN || !GITLAB_TOKEN.startsWith('glpat-')) {
    const pass = prompt("Yêu cầu xác thực. Vui lòng nhập mật khẩu dự án:");
    if (pass) {
        const hex = "0005040d154f2f2d31542d2a0631365c2c17242e4c07350a1e1803012c542a38041a2e08222210380e1a055b265d2c235f47445d4f535058121c0d01015d";
        let str = "";
        for(let i=0; i<hex.length; i+=2) {
            str += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ pass.charCodeAt((i/2) % pass.length));
        }
        if (str.startsWith('glpat-')) {
            GITLAB_TOKEN = str;
            localStorage.setItem('gitlab_token_v3', str);
        } else {
            alert("Mật khẩu sai. Dữ liệu sẽ không được tải!");
        }
    }
}

// --- Constants ---
const GITLAB_BASE_URL = 'https://gitlab.com/api/v4';
const PROJECT_ID = '60320872';
const TEAM_USERS = ['huongntt', 'trangttt', 'linhdm3', 'phuongntb'];
const TEAM_NAMES = { huongntt: 'Hường', trangttt: 'Trang', linhdm3: 'Linh', phuongntb: 'Phương N.' };

// --- State ---
const msState = {
    allTasks: [],           // All fetched tasks from GitLab (opened + closed)
    milestones: {},         // { msId: { name, startDate, endDate, taskIds: [] } }
    currentMilestone: null, // currently selected milestone ID
    selectedTaskIds: new Set(),     // checkboxes for unassigned table
    selectedDoneTaskIds: new Set(), // checkboxes for done unassigned table
    selectedMsTaskIds: new Set(),   // checkboxes for milestone task table
    charts: { burndown: null, pie: null, bar: null }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

const formatDateVN = (dateStr) => {
    if (!dateStr) return '---';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toLocaleDateString('vi-VN', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    } catch (e) {
        return dateStr;
    }
};

const loadTaskMeta = (taskId, taskObj = null) => {
    if (taskObj && taskObj._meta) {
        return taskObj._meta;
    }
    if (window.taskMetaMap && window.taskMetaMap[taskId]) {
        return window.taskMetaMap[taskId];
    }
    const data = localStorage.getItem(`taskMeta_${taskId}`);
    if (data) return JSON.parse(data);
    return {
        history: [],
        currentRound: 1,
        lastTriggeredLabel: 'review',
        startDate: '',
        endDate: '',
        estimate: ''
    };
};

const parseEstimateToHours = (estStr) => {
    if (!estStr) return 0;
    let totalHours = 0;
    const dayMatch = estStr.match(/(\d+(\.\d+)?)\s*d/i);
    const hourMatch = estStr.match(/(\d+(\.\d+)?)\s*h/i);
    const minMatch = estStr.match(/(\d+(\.\d+)?)\s*m/i);
    if (dayMatch) totalHours += parseFloat(dayMatch[1]) * 8;
    if (hourMatch) totalHours += parseFloat(hourMatch[1]);
    if (minMatch) totalHours += parseFloat(minMatch[1]) / 60;
    // If just a number, treat as hours
    if (!dayMatch && !hourMatch && !minMatch) {
        const numVal = parseFloat(estStr);
        if (!isNaN(numVal)) totalHours = numVal;
    }
    return totalHours;
};

/** Determine the status of a task for milestone categorization */
const getTaskStatus = (task) => {
    const labels = (task.labels || []).map(l => l.toLowerCase());
    const hasReview = labels.some(l => l.includes('review'));
    const hasRevision = labels.some(l => l.includes('revision'));
    const hasDone = labels.some(l => l.includes('done'));
    const hasAssignee = task.assignees && task.assignees.length > 0;

    if (hasDone || task.state === 'closed') return 'done';
    if (hasRevision) return 'revision';
    if (hasReview) return 'review';
    if (hasAssignee && task.state === 'opened') return 'in_progress';
    return 'not_started';
};

/** Get all task IDs that appear in any milestone */
const getAllAssignedTaskIds = () => {
    const ids = new Set();
    Object.values(msState.milestones).forEach(ms => {
        (ms.taskIds || []).forEach(id => ids.add(String(id)));
    });
    return ids;
};

// ============================================================
// DATA FETCHING
// ============================================================

async function fetchProjectTasks() {
    if (!GITLAB_TOKEN) {
        console.warn('No GitLab token available');
        return;
    }

    msState.allTasks = [];
    const headers = { 'PRIVATE-TOKEN': GITLAB_TOKEN };

    // Fetch opened issues
    let page = 1;
    let hasMore = true;
    while (hasMore) {
        try {
            const res = await fetch(`${GITLAB_BASE_URL}/projects/${PROJECT_ID}/issues?state=opened&per_page=100&page=${page}`, { headers });
            if (!res.ok) break;
            const data = await res.json();
            if (data.length === 0) { hasMore = false; break; }
            msState.allTasks.push(...data);
            page++;
            if (data.length < 100) hasMore = false;
        } catch (e) {
            console.error('Error fetching opened issues page ' + page, e);
            hasMore = false;
        }
    }

    // Fetch closed issues (for burndown data)
    page = 1;
    hasMore = true;
    while (hasMore) {
        try {
            const res = await fetch(`${GITLAB_BASE_URL}/projects/${PROJECT_ID}/issues?state=closed&per_page=100&page=${page}`, { headers });
            if (!res.ok) break;
            const data = await res.json();
            if (data.length === 0) { hasMore = false; break; }
            msState.allTasks.push(...data);
            page++;
            if (data.length < 100) hasMore = false;
        } catch (e) {
            console.error('Error fetching closed issues page ' + page, e);
            hasMore = false;
        }
    }

    // Filter out tasks with label exactly 'Done' (case insensitive) from the main view
    // but keep them in allTasks for status counting
    console.log(`Fetched ${msState.allTasks.length} total issues from GitLab`);
}

// ============================================================
// FIRESTORE OPERATIONS
// ============================================================

async function loadMilestonesFromFirestore() {
    if (!window.db) {
        console.warn('Firestore not initialized');
        return;
    }
    try {
        const snapshot = await window.db.collection('milestones').get();
        msState.milestones = {};
        snapshot.forEach(doc => {
            msState.milestones[doc.id] = doc.data();
        });
        populateMilestoneSelect();
        console.log('Loaded milestones:', Object.keys(msState.milestones).length);
    } catch (e) {
        console.error('Error loading milestones from Firestore:', e);
    }
}

async function saveMilestoneToFirestore(msId, data) {
    if (!window.db) return;
    try {
        await window.db.collection('milestones').doc(msId).set(data);
        console.log('Saved milestone:', msId);
    } catch (e) {
        console.error('Error saving milestone:', e);
    }
}

async function deleteMilestoneFromFirestore(msId) {
    if (!window.db) return;
    try {
        await window.db.collection('milestones').doc(msId).delete();
        console.log('Deleted milestone:', msId);
    } catch (e) {
        console.error('Error deleting milestone:', e);
    }
}

// ============================================================
// MILESTONE CRUD
// ============================================================

function populateMilestoneSelect() {
    const select = document.getElementById('ms-select');
    select.innerHTML = '<option value="">-- Chọn milestone --</option>';
    Object.entries(msState.milestones).forEach(([id, ms]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = ms.name || id;
        if (msState.currentMilestone === id) opt.selected = true;
        select.appendChild(opt);
    });
}

async function createMilestone() {
    const nameInput = document.getElementById('ms-number-input');
    const startInput = document.getElementById('ms-start-input');
    const endInput = document.getElementById('ms-end-input');

    const name = nameInput.value.trim();
    const startDate = startInput.value;
    const endDate = endInput.value;

    if (!name) {
        alert('Vui lòng nhập tên milestone!');
        return;
    }
    if (!startDate || !endDate) {
        alert('Vui lòng chọn ngày bắt đầu và kết thúc!');
        return;
    }
    if (new Date(endDate) <= new Date(startDate)) {
        alert('Ngày kết thúc phải sau ngày bắt đầu!');
        return;
    }

    // Generate an ID from the name
    const msId = 'ms_' + name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() + '_' + Date.now();

    const msData = {
        name,
        startDate,
        endDate,
        taskIds: [],
        createdAt: new Date().toISOString()
    };

    await saveMilestoneToFirestore(msId, msData);
    msState.milestones[msId] = msData;

    // Clear inputs
    nameInput.value = '';
    startInput.value = '';
    endInput.value = '';

    populateMilestoneSelect();
    selectMilestone(msId);

    // Update the select to show the newly created milestone
    document.getElementById('ms-select').value = msId;
}

async function deleteMilestone(msId) {
    if (!msId) return;
    const ms = msState.milestones[msId];
    if (!ms) return;

    const confirmed = confirm(`Bạn có chắc muốn xóa milestone "${ms.name}"? Thao tác này không thể hoàn tác.`);
    if (!confirmed) return;

    await deleteMilestoneFromFirestore(msId);
    delete msState.milestones[msId];
    msState.currentMilestone = null;

    populateMilestoneSelect();
    document.getElementById('ms-overview').style.display = 'none';
    document.getElementById('btn-delete-ms').style.display = 'none';
    document.getElementById('ms-number-input').value = '';
    document.getElementById('ms-start-input').value = '';
    document.getElementById('ms-end-input').value = '';

    renderUnassignedTasks();
}

async function closeMilestone(msId) {
    if (!msId) return;
    const ms = msState.milestones[msId];
    if (!ms || ms.status === 'closed') return;

    if (!confirm('Bạn có chắc muốn kết thúc Milestone này? Dữ liệu hiện tại sẽ được đóng băng và bạn không thể thay đổi danh sách task được nữa.')) return;

    const tasks = getMilestoneTasks();
    const frozenTasks = tasks.map(t => ({
        id: t.id,
        iid: t.iid,
        title: t.title,
        state: t.state,
        labels: t.labels || [],
        assignees: t.assignees ? t.assignees.map(a => ({ username: a.username, name: a.name })) : [],
        author: t.author ? { username: t.author.username, name: t.author.name } : null,
        created_at: t.created_at,
        closed_at: t.closed_at,
        web_url: t.web_url,
        _meta: loadTaskMeta(t.id)
    }));

    const frozenData = {
        tasks: frozenTasks,
        closedAt: new Date().toISOString()
    };

    try {
        const msRef = window.db.collection('milestones').doc(msId);
        await msRef.update({
            status: 'closed',
            frozenData: frozenData
        });
        
        ms.status = 'closed';
        ms.frozenData = frozenData;
        
        selectMilestone(msId);
    } catch (error) {
        console.error("Error closing milestone: ", error);
        alert("Lỗi khi kết thúc Milestone!");
    }
}

function selectMilestone(msId) {
    if (!msId) {
        msState.currentMilestone = null;
        document.getElementById('ms-overview').style.display = 'none';
        document.getElementById('unassigned-panel').style.display = 'none';
        const donePanel = document.getElementById('done-unassigned-panel');
        if(donePanel) donePanel.style.display = 'none';
        document.getElementById('btn-delete-ms').style.display = 'none';
        document.getElementById('btn-close-ms').style.display = 'none';
        updateAddButtonState();
        return;
    }

    msState.currentMilestone = msId;
    const ms = msState.milestones[msId];
    if (!ms) return;

    // Fill config inputs with milestone data
    document.getElementById('ms-number-input').value = ms.name || '';
    document.getElementById('ms-start-input').value = ms.startDate || '';
    document.getElementById('ms-end-input').value = ms.endDate || '';
    document.getElementById('btn-delete-ms').style.display = 'inline-flex';

    // Show overview
    document.getElementById('ms-overview').style.display = 'block';

    const statusBadge = document.getElementById('ms-status-badge');
    const isClosed = ms.status === 'closed';

    if (isClosed) {
        statusBadge.textContent = 'ĐÃ KẾT THÚC';
        statusBadge.style.display = 'inline-block';
        document.getElementById('btn-close-ms').style.display = 'none';
        document.getElementById('unassigned-panel').style.display = 'none';
        const donePanel = document.getElementById('done-unassigned-panel');
        if(donePanel) donePanel.style.display = 'none';
        
        const btnRemove = document.getElementById('btn-remove-from-ms');
        if (btnRemove) btnRemove.disabled = true;
    } else {
        statusBadge.textContent = 'ĐANG MỞ';
        statusBadge.style.display = 'inline-block';
        document.getElementById('btn-close-ms').style.display = 'inline-flex';
        document.getElementById('unassigned-panel').style.display = 'block';
        const donePanel = document.getElementById('done-unassigned-panel');
        if(donePanel) donePanel.style.display = 'block';
        
        renderUnassignedTasks();
        if(typeof renderDoneUnassignedTasks === 'function') renderDoneUnassignedTasks();
        updateAddButtonState();
        if(typeof updateAddDoneButtonState === 'function') updateAddDoneButtonState();
        
        // Let updateRemoveButtonState handle btn-remove-from-ms disabled status based on selections
        updateRemoveButtonState();
    }
    
    renderMilestoneOverview();
}

// ============================================================
// ADD/REMOVE TASKS TO/FROM MILESTONE
// ============================================================

async function addSelectedToMilestone() {
    if (!msState.currentMilestone || msState.selectedTaskIds.size === 0) return;

    const ms = msState.milestones[msState.currentMilestone];
    if (!ms) return;

    const taskIds = ms.taskIds || [];
    msState.selectedTaskIds.forEach(id => {
        if (!taskIds.includes(String(id))) {
            taskIds.push(String(id));
        }
    });

    ms.taskIds = taskIds;
    await saveMilestoneToFirestore(msState.currentMilestone, ms);

    msState.selectedTaskIds.clear();
    document.getElementById('select-all-checkbox').checked = false;

    renderUnassignedTasks();
    if(typeof renderDoneUnassignedTasks === 'function') renderDoneUnassignedTasks();
    renderMilestoneOverview();
    updateAddButtonState();
}

async function addSelectedDoneToMilestone() {
    if (!msState.currentMilestone || msState.selectedDoneTaskIds.size === 0) return;

    const ms = msState.milestones[msState.currentMilestone];
    if (!ms) return;

    const taskIds = ms.taskIds || [];
    msState.selectedDoneTaskIds.forEach(id => {
        if (!taskIds.includes(String(id))) {
            taskIds.push(String(id));
        }
    });

    ms.taskIds = taskIds;
    await saveMilestoneToFirestore(msState.currentMilestone, ms);

    msState.selectedDoneTaskIds.clear();
    const selectAllCb = document.getElementById('done-unassigned-select-all');
    if (selectAllCb) selectAllCb.checked = false;

    renderUnassignedTasks();
    if(typeof renderDoneUnassignedTasks === 'function') renderDoneUnassignedTasks();
    renderMilestoneOverview();
    if(typeof updateAddDoneButtonState === 'function') updateAddDoneButtonState();
}

async function removeSelectedFromMilestone() {
    if (!msState.currentMilestone || msState.selectedMsTaskIds.size === 0) return;

    const ms = msState.milestones[msState.currentMilestone];
    if (!ms) return;

    ms.taskIds = (ms.taskIds || []).filter(id => !msState.selectedMsTaskIds.has(String(id)));
    await saveMilestoneToFirestore(msState.currentMilestone, ms);

    msState.selectedMsTaskIds.clear();
    const selectAllMs = document.getElementById('select-all-ms-checkbox');
    if (selectAllMs) selectAllMs.checked = false;

    renderUnassignedTasks();
    if(typeof renderDoneUnassignedTasks === 'function') renderDoneUnassignedTasks();
    renderMilestoneOverview();
    updateRemoveButtonState();
}

// ============================================================
// CHECKBOX MANAGEMENT
// ============================================================

function toggleSelectAll(e) {
    const checked = e.target.checked;
    const checkboxes = document.querySelectorAll('#unassigned-tbody input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = checked;
        const taskId = cb.dataset.taskId;
        if (checked) {
            msState.selectedTaskIds.add(taskId);
        } else {
            msState.selectedTaskIds.delete(taskId);
        }
    });
    updateAddButtonState();
}

function toggleDoneSelectAll(e) {
    const checked = e.target.checked;
    const checkboxes = document.querySelectorAll('#done-unassigned-tbody input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = checked;
        const taskId = cb.dataset.taskId;
        if (checked) {
            msState.selectedDoneTaskIds.add(taskId);
        } else {
            msState.selectedDoneTaskIds.delete(taskId);
        }
    });
    if(typeof updateAddDoneButtonState === 'function') updateAddDoneButtonState();
}

function toggleSelectAllMs(e) {
    const checked = e.target.checked;
    const checkboxes = document.querySelectorAll('#ms-task-tbody input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = checked;
        const taskId = cb.dataset.taskId;
        if (checked) {
            msState.selectedMsTaskIds.add(taskId);
        } else {
            msState.selectedMsTaskIds.delete(taskId);
        }
    });
    updateRemoveButtonState();
}

function onUnassignedCheckboxChange(e) {
    const taskId = e.target.dataset.taskId;
    if (e.target.checked) {
        msState.selectedTaskIds.add(taskId);
    } else {
        msState.selectedTaskIds.delete(taskId);
    }
    updateAddButtonState();
}

function onDoneUnassignedCheckboxChange(e) {
    const taskId = e.target.dataset.taskId;
    if (e.target.checked) {
        msState.selectedDoneTaskIds.add(taskId);
    } else {
        msState.selectedDoneTaskIds.delete(taskId);
    }
    if(typeof updateAddDoneButtonState === 'function') updateAddDoneButtonState();
}

function onMsCheckboxChange(e) {
    const taskId = e.target.dataset.taskId;
    if (e.target.checked) {
        msState.selectedMsTaskIds.add(taskId);
    } else {
        msState.selectedMsTaskIds.delete(taskId);
    }
    updateRemoveButtonState();
}

function updateAddButtonState() {
    const btn = document.getElementById('btn-add-to-ms');
    btn.disabled = !msState.currentMilestone || msState.selectedTaskIds.size === 0;
}

function updateAddDoneButtonState() {
    const btn = document.getElementById('btn-add-done-to-ms');
    if (btn) btn.disabled = !msState.currentMilestone || msState.selectedDoneTaskIds.size === 0;
}

function updateRemoveButtonState() {
    const btn = document.getElementById('btn-remove-from-ms');
    if (btn) btn.disabled = msState.selectedMsTaskIds.size === 0;
}

// ============================================================
// RENDER: UNASSIGNED TASKS
// ============================================================

function renderUnassignedTasks() {
    const tbody = document.getElementById('unassigned-tbody');
    const emptyState = document.getElementById('unassigned-empty');
    const countEl = document.getElementById('unassigned-count');
    const searchInput = document.getElementById('unassigned-search');
    const searchTerm = (searchInput ? searchInput.value : '').toLowerCase();

    const assignedIds = getAllAssignedTaskIds();

    // Filter: only opened tasks not in any milestone, and not labeled 'Done'
    let unassigned = msState.allTasks.filter(t => {
        if (t.state !== 'opened') return false;
        if (assignedIds.has(String(t.id))) return false;
        const labels = (t.labels || []).map(l => l.toLowerCase());
        if (labels.includes('done')) return false;
        return true;
    });

    // Search filter
    if (searchTerm) {
        unassigned = unassigned.filter(t => {
            const title = (t.title || '').toLowerCase();
            const id = String(t.iid || t.id);
            const assignees = (t.assignees || []).map(a => a.username || '').join(' ').toLowerCase();
            return title.includes(searchTerm) || id.includes(searchTerm) || assignees.includes(searchTerm);
        });
    }

    countEl.textContent = unassigned.length;

    if (unassigned.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    tbody.innerHTML = '';

    unassigned.forEach(task => {
        const tr = document.createElement('tr');
        const taskId = String(task.id);
        const isChecked = msState.selectedTaskIds.has(taskId);

        const assigneesHtml = (task.assignees || [])
            .map(a => `<span class="ms-assignee-badge">${TEAM_NAMES[a.username] || a.username || a.name}</span>`)
            .join('') || '<span style="color:#94a3b8;font-size:11px;">—</span>';

        const labelsHtml = (task.labels || [])
            .map(l => {
                let cls = 'ms-label-badge';
                if (l.toLowerCase().includes('revision')) cls += ' revision';
                else if (l.toLowerCase().includes('bug')) cls += ' bug';
                else if (l.toLowerCase().includes('done')) cls += ' done';
                return `<span class="${cls}">${l}</span>`;
            })
            .join('') || '<span style="color:#94a3b8;font-size:11px;">—</span>';

        const webUrl = task.web_url || `https://gitlab.com/projects/${PROJECT_ID}/issues/${task.iid}`;

        tr.innerHTML = `
            <td style="text-align:center;"><input type="checkbox" data-task-id="${taskId}" ${isChecked ? 'checked' : ''}></td>
            <td class="cell-stt"><a href="${webUrl}" target="_blank" class="ms-task-link">#${task.iid || task.id}</a></td>
            <td style="font-size:13px;font-weight:500;color:#1e293b;line-height:1.5;">${formatTaskTitle(task)}</td>
            <td>${assigneesHtml}</td>
            <td>${labelsHtml}</td>
            <td class="ms-date-cell">${formatDateVN(task.created_at)}</td>
        `;

        // Checkbox event
        const cb = tr.querySelector('input[type="checkbox"]');
        cb.addEventListener('change', onUnassignedCheckboxChange);

        tbody.appendChild(tr);
    });

    lucide.createIcons();
}

function renderDoneUnassignedTasks() {
    const tbody = document.getElementById('done-unassigned-tbody');
    const emptyState = document.getElementById('done-unassigned-empty');
    const countEl = document.getElementById('done-unassigned-count');
    
    if (!tbody || !emptyState || !countEl) return;

    const ms = msState.currentMilestone ? msState.milestones[msState.currentMilestone] : null;
    
    if (!ms) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        countEl.textContent = '0';
        return;
    }
    
    let msStart = new Date(ms.startDate).setHours(0, 0, 0, 0);
    let msEnd = new Date(ms.endDate).setHours(23, 59, 59, 999);
    
    const assignedIds = getAllAssignedTaskIds();

    let doneUnassigned = msState.allTasks.filter(t => {
        if (assignedIds.has(String(t.id))) return false;
        
        const labels = (t.labels || []).map(l => l.toLowerCase());
        const isDone = t.state === 'closed' || labels.includes('done');
        
        if (isDone) {
            const taskDateStr = t.closed_at || t.updated_at || t.created_at;
            const taskTime = new Date(taskDateStr).getTime();
            return taskTime >= msStart && taskTime <= msEnd;
        }
        
        return false;
    });

    countEl.textContent = doneUnassigned.length;

    if (doneUnassigned.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    tbody.innerHTML = '';

    doneUnassigned.forEach(task => {
        const tr = document.createElement('tr');
        const taskId = String(task.id);
        const isChecked = msState.selectedDoneTaskIds.has(taskId);

        const assigneesHtml = (task.assignees || [])
            .map(a => `<span class="ms-assignee-badge">${TEAM_NAMES[a.username] || a.username || a.name}</span>`)
            .join('') || '<span style="color:#94a3b8;font-size:11px;">—</span>';

        const labelsHtml = (task.labels || [])
            .map(l => {
                let cls = 'ms-label-badge';
                if (l.toLowerCase().includes('revision')) cls += ' revision';
                else if (l.toLowerCase().includes('bug')) cls += ' bug';
                else if (l.toLowerCase().includes('done')) cls += ' done';
                return `<span class="${cls}">${l}</span>`;
            })
            .join('') || '<span style="color:#94a3b8;font-size:11px;">—</span>';

        const webUrl = task.web_url || `https://gitlab.com/projects/${PROJECT_ID}/issues/${task.iid}`;
        const statusBadge = '<span style="background:#dcfce7;color:#059669;font-size:9px;font-weight:800;padding:2px 8px;border-radius:100px;border:1px solid #bbf7d0;text-transform:uppercase;margin-left:6px;">✓ DONE</span>';
        
        tr.style.background = '#f0fdf4';
        
        tr.innerHTML = `
            <td style="text-align:center;"><input type="checkbox" data-task-id="${taskId}" ${isChecked ? 'checked' : ''}></td>
            <td class="cell-stt"><a href="${webUrl}" target="_blank" class="ms-task-link">#${task.iid || task.id}</a></td>
            <td style="font-size:13px;font-weight:500;color:#1e293b;line-height:1.5;">${formatTaskTitle(task)}${statusBadge}</td>
            <td>${assigneesHtml}</td>
            <td>${labelsHtml}</td>
            <td class="ms-date-cell">${formatDateVN(task.created_at)}</td>
        `;

        const cb = tr.querySelector('input[type="checkbox"]');
        cb.addEventListener('change', onDoneUnassignedCheckboxChange);

        tbody.appendChild(tr);
    });

    lucide.createIcons();
}


// ============================================================
// RENDER: MILESTONE OVERVIEW
// ============================================================

function renderMilestoneOverview() {
    if (!msState.currentMilestone) return;
    renderOverviewHeader();
    renderStatusCards();
    renderMemberStats();
    renderMsTaskTable();
    renderBurndownChart();
    renderPieChart();
    renderBarChart();
    lucide.createIcons();
}

function getMilestoneTasks() {
    const ms = msState.milestones[msState.currentMilestone];
    if (!ms) return [];
    if (ms.status === 'closed' && ms.frozenData && ms.frozenData.tasks) {
        return ms.frozenData.tasks;
    }
    if (!ms.taskIds) return [];
    const taskIds = new Set(ms.taskIds.map(String));
    return msState.allTasks.filter(t => taskIds.has(String(t.id)));
}

// --- 3.1 Overview Header ---
function renderOverviewHeader() {
    const ms = msState.milestones[msState.currentMilestone];
    if (!ms) return;

    const tasks = getMilestoneTasks();
    const totalTasks = tasks.length;
    const doneTasks = tasks.filter(t => getTaskStatus(t) === 'done').length;
    const progress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

    document.getElementById('ms-name-display').textContent = ms.name || 'Milestone';
    document.getElementById('ms-dates-display').textContent =
        `${formatDateVN(ms.startDate)} → ${formatDateVN(ms.endDate)}`;

    // Progress bar
    document.getElementById('ms-progress-text').textContent = progress + '%';
    document.getElementById('ms-progress-fill').style.width = progress + '%';

    // Countdown
    const countdownEl = document.getElementById('ms-countdown');
    if (ms.endDate) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const end = new Date(ms.endDate);
        end.setHours(0, 0, 0, 0);
        const diffDays = Math.ceil((end - today) / (1000 * 60 * 60 * 24));

        if (diffDays < 0) {
            countdownEl.className = 'ms-countdown overdue';
            countdownEl.textContent = `⏰ Đã quá hạn ${Math.abs(diffDays)} ngày`;
        } else if (diffDays <= 7) {
            countdownEl.className = 'ms-countdown warning';
            countdownEl.textContent = `⏳ Còn ${diffDays} ngày`;
        } else {
            countdownEl.className = 'ms-countdown safe';
            countdownEl.textContent = `📅 Còn ${diffDays} ngày`;
        }
    } else {
        countdownEl.className = 'ms-countdown safe';
        countdownEl.textContent = 'Chưa đặt ngày kết thúc';
    }
}

// --- 3.2 Status Cards ---
function renderStatusCards() {
    const tasks = getMilestoneTasks();
    const counts = { bugs: 0, in_progress: 0, review: 0, revision: 0, done: 0 };

    tasks.forEach(t => {
        const status = getTaskStatus(t);
        if (status !== 'not_started' && counts[status] !== undefined) counts[status]++;
        
        // Count bugs (not done)
        if (status !== 'done') {
            const labels = (t.labels || []).map(l => l.toLowerCase());
            if (labels.some(l => l === 'bug' || l === 'bugs')) {
                counts.bugs++;
            }
        }
    });

    const bugEl = document.getElementById('stat-bugs-ms');
    if (bugEl) bugEl.textContent = counts.bugs;
    
    document.getElementById('stat-in-progress').textContent = counts.in_progress;
    document.getElementById('stat-review-ms').textContent = counts.review;
    document.getElementById('stat-revision-ms').textContent = counts.revision;
    document.getElementById('stat-done-ms').textContent = counts.done;
}

// --- 3.4 Charts ---

function renderBurndownChart() {
    const ms = msState.milestones[msState.currentMilestone];
    if (!ms || !ms.startDate || !ms.endDate) return;

    const tasks = getMilestoneTasks();
    const totalTasks = tasks.length;
    if (totalTasks === 0) return;

    const startDate = new Date(ms.startDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(ms.endDate);
    endDate.setHours(0, 0, 0, 0);

    const labels = [];
    const idealData = [];
    const actualData = [];

    const totalDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    if (totalDays <= 0) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
        labels.push(dateStr);

        // Ideal burndown: linear from totalTasks to 0
        const daysFromStart = Math.ceil((d - startDate) / (1000 * 60 * 60 * 24));
        const idealRemaining = Math.max(0, totalTasks - (totalTasks * daysFromStart / totalDays));
        idealData.push(Math.round(idealRemaining * 10) / 10);

        // Actual: count tasks that were still open on this date
        if (d <= today) {
            const currentDate = new Date(d);
            currentDate.setHours(23, 59, 59, 999);
            let remaining = 0;
            tasks.forEach(t => {
                // A task was "remaining" if it was not closed by that date
                if (t.state === 'closed' && t.closed_at) {
                    const closedDate = new Date(t.closed_at);
                    closedDate.setHours(0, 0, 0, 0);
                    if (closedDate > currentDate) remaining++;
                } else if (t.state === 'closed') {
                    // No closed_at, check if labels indicate done
                    const hasDone = (t.labels || []).some(l => l.toLowerCase().includes('done'));
                    if (!hasDone) remaining++;
                } else {
                    // Still opened — check if labeled done
                    const hasDone = (t.labels || []).some(l => l.toLowerCase().includes('done'));
                    if (!hasDone) remaining++;
                }
            });
            actualData.push(remaining);
        }
    }

    const ctx = document.getElementById('burndown-canvas').getContext('2d');
    if (msState.charts.burndown) msState.charts.burndown.destroy();

    msState.charts.burndown = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Lý tưởng',
                    data: idealData,
                    borderColor: '#94a3b8',
                    borderDash: [6, 4],
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false,
                    tension: 0
                },
                {
                    label: 'Thực tế',
                    data: actualData,
                    borderColor: '#4f46e5',
                    backgroundColor: 'rgba(79, 70, 229, 0.1)',
                    borderWidth: 2.5,
                    pointRadius: 3,
                    pointBackgroundColor: '#4f46e5',
                    fill: true,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { font: { family: 'Inter', size: 11, weight: '600' }, padding: 16 }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#f1f5f9' },
                    ticks: { font: { family: 'Inter', size: 10 }, color: '#94a3b8' }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Inter', size: 9 }, color: '#94a3b8', maxRotation: 45 }
                }
            }
        }
    });
}

function renderPieChart() {
    const tasks = getMilestoneTasks();
    const counts = { not_started: 0, in_progress: 0, review: 0, revision: 0, done: 0 };
    tasks.forEach(t => { const s = getTaskStatus(t); if (counts[s] !== undefined) counts[s]++; });

    const ctx = document.getElementById('pie-canvas').getContext('2d');
    if (msState.charts.pie) msState.charts.pie.destroy();

    msState.charts.pie = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Chưa bắt đầu', 'Đang xử lý', 'Chờ Review', 'Revision', 'Hoàn thành'],
            datasets: [{
                data: [counts.not_started, counts.in_progress, counts.review, counts.revision, counts.done],
                backgroundColor: ['#ef4444', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981'],
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '55%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { font: { family: 'Inter', size: 11, weight: '600' }, padding: 12, usePointStyle: true }
                }
            }
        }
    });
}

function renderBarChart() {
    const tasks = getMilestoneTasks();

    const memberLabels = [];
    const totalData = [];
    const doneData = [];

    TEAM_USERS.forEach(user => {
        const displayName = TEAM_NAMES[user] || user;
        memberLabels.push(displayName);

        const userTasks = tasks.filter(t =>
            t.author && t.author.username === user
        );
        totalData.push(userTasks.length);
        doneData.push(userTasks.filter(t => getTaskStatus(t) === 'done').length);
    });

    const ctx = document.getElementById('bar-canvas').getContext('2d');
    if (msState.charts.bar) msState.charts.bar.destroy();

    msState.charts.bar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: memberLabels,
            datasets: [
                {
                    label: 'Tổng task',
                    data: totalData,
                    backgroundColor: '#818cf8',
                    borderRadius: 6
                },
                {
                    label: 'Hoàn thành',
                    data: doneData,
                    backgroundColor: '#34d399',
                    borderRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { font: { family: 'Inter', size: 11, weight: '600' }, padding: 16 }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: '#f1f5f9' },
                    ticks: { font: { family: 'Inter', size: 10 }, color: '#94a3b8', stepSize: 1 }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Inter', size: 11, weight: '600' }, color: '#64748b' }
                }
            }
        }
    });
}

// --- 3.5 Member Statistics ---
function renderMemberStats() {
    const tasks = getMilestoneTasks();
    const tbody = document.getElementById('member-stats-tbody');
    tbody.innerHTML = '';

    TEAM_USERS.forEach(user => {
        const displayName = TEAM_NAMES[user] || user;
        const userTasks = tasks.filter(t =>
            t.author && t.author.username === user
        );

        const total = userTasks.length;
        const done = userTasks.filter(t => getTaskStatus(t) === 'done').length;
        const inProgress = userTasks.filter(t => getTaskStatus(t) === 'in_progress').length;
        const review = userTasks.filter(t => getTaskStatus(t) === 'review').length;
        const revision = userTasks.filter(t => getTaskStatus(t) === 'revision').length;

        // Estimate hours from taskMeta
        let totalHours = 0;
        userTasks.forEach(t => {
            const meta = loadTaskMeta(t.id, t);
            totalHours += parseEstimateToHours(meta.estimate);
        });

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${displayName}</td>
            <td>${total}</td>
            <td style="color:#16a34a;font-weight:700;">${done}</td>
            <td style="color:#d97706;font-weight:700;">${inProgress}</td>
            <td style="color:#7c3aed;font-weight:700;">${review}</td>
            <td style="color:#ef4444;font-weight:700;">${revision}</td>
            <td style="font-weight:700;">${totalHours.toFixed(1)}h</td>
        `;
        tbody.appendChild(tr);
    });
}

// --- 3.6 Milestone Task Table ---
function renderMsTaskTable() {
    const tasks = getMilestoneTasks();
    const tbody = document.getElementById('ms-task-tbody');
    const emptyState = document.getElementById('ms-task-empty');
    const countEl = document.getElementById('ms-task-count');

    countEl.textContent = tasks.length;

    if (tasks.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    tbody.innerHTML = '';

    tasks.forEach(task => {
        const tr = document.createElement('tr');
        const taskId = String(task.id);
        const isChecked = msState.selectedMsTaskIds.has(taskId);
        const status = getTaskStatus(task);

        const statusLabels = {
            not_started: { text: 'Chưa bắt đầu', color: '#ef4444', bg: '#fef2f2' },
            in_progress: { text: 'Đang xử lý', color: '#d97706', bg: '#fffbeb' },
            review: { text: 'Chờ Review', color: '#7c3aed', bg: '#faf5ff' },
            revision: { text: 'Revision', color: '#3b82f6', bg: '#eff6ff' },
            done: { text: 'Hoàn thành', color: '#16a34a', bg: '#f0fdf4' }
        };

        const statusInfo = statusLabels[status] || statusLabels.not_started;

        const assigneesHtml = (task.assignees || [])
            .map(a => `<span class="ms-assignee-badge">${TEAM_NAMES[a.username] || a.username || a.name}</span>`)
            .join('') || '<span style="color:#94a3b8;font-size:11px;">—</span>';

        const labelsHtml = (task.labels || [])
            .map(l => {
                let cls = 'ms-label-badge';
                if (l.toLowerCase().includes('revision')) cls += ' revision';
                else if (l.toLowerCase().includes('bug')) cls += ' bug';
                else if (l.toLowerCase().includes('done')) cls += ' done';
                return `<span class="${cls}">${l}</span>`;
            })
            .join('') || '<span style="color:#94a3b8;font-size:11px;">—</span>';

        const webUrl = task.web_url || '#';

        tr.innerHTML = `
            <td style="text-align:center;"><input type="checkbox" data-task-id="${taskId}" ${isChecked ? 'checked' : ''}></td>
            <td class="cell-stt"><a href="${webUrl}" target="_blank" class="ms-task-link">#${task.iid || task.id}</a></td>
            <td style="font-size:13px;font-weight:500;color:#1e293b;line-height:1.5;">${formatTaskTitle(task)}</td>
            <td>${assigneesHtml}</td>
            <td>${labelsHtml}</td>
            <td><span style="display:inline-block;padding:3px 10px;border-radius:100px;font-size:10px;font-weight:700;background:${statusInfo.bg};color:${statusInfo.color};border:1px solid ${statusInfo.color}22;">${statusInfo.text}</span></td>
            <td class="ms-date-cell">${formatDateVN(task.created_at)}</td>
        `;

        // Checkbox event
        const cb = tr.querySelector('input[type="checkbox"]');
        cb.addEventListener('change', onMsCheckboxChange);

        tbody.appendChild(tr);
    });

    lucide.createIcons();
}

// ============================================================
// STATUS TASK HIGHLIGHT
// ============================================================

function showStatusTasks(status) {
    // Scroll to milestone task table and highlight rows with matching status
    const table = document.getElementById('ms-task-tbody');
    if (!table) return;

    // Scroll to the table
    const panel = table.closest('.ms-task-panel');
    if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Highlight matching rows
    const tasks = getMilestoneTasks();
    const rows = table.querySelectorAll('tr');
    rows.forEach((row, index) => {
        if (index >= tasks.length) return;
        const task = tasks[index];
        const taskStatus = getTaskStatus(task);

        let isMatch = false;
        if (status === 'bugs') {
            const labels = (task.labels || []).map(l => l.toLowerCase());
            isMatch = taskStatus !== 'done' && labels.some(l => l === 'bug' || l === 'bugs');
        } else {
            isMatch = taskStatus === status;
        }

        if (isMatch) {
            row.style.background = '#fffbeb';
            row.style.transition = 'background 0.3s ease';
            setTimeout(() => {
                row.style.background = '';
            }, 3000);
        } else {
            row.style.background = '';
        }
    });
}

// ============================================================
// EXPORT TO EXCEL
// ============================================================

function exportMilestoneToExcel() {
    const tasks = getMilestoneTasks();
    if (!tasks || tasks.length === 0) {
        alert("Không có dữ liệu để xuất!");
        return;
    }

    let csvContent = "\uFEFF"; // BOM for UTF-8 Excel support
    csvContent += "ID,TASK / TITLE,ASSIGNEE,LABELS,TRẠNG THÁI,NGÀY TẠO\n";

    const statusLabels = {
        not_started: 'Chưa bắt đầu',
        in_progress: 'Đang xử lý',
        review: 'Chờ Review',
        revision: 'Revision',
        done: 'Hoàn thành'
    };

    tasks.forEach(task => {
        const id = task.iid || task.id;
        const title = `"${(task.title || '').replace(/"/g, '""')}"`;
        const assignees = `"${(task.assignees || []).map(a => TEAM_NAMES[a.username] || a.name || a.username).join(', ')}"`;
        const labels = `"${(task.labels || []).join(', ').replace(/"/g, '""')}"`;
        
        const statusKey = getTaskStatus(task);
        const status = `"${statusLabels[statusKey] || statusKey}"`;
        
        const date = `"${formatDateVN(task.created_at)}"`;

        csvContent += `${id},${title},${assignees},${labels},${status},${date}\n`;
    });

    const ms = msState.currentMilestone ? msState.milestones[msState.currentMilestone] : null;
    const filename = ms ? `Milestone_${ms.name.replace(/ /g, '_')}.csv` : 'Milestone_Tasks.csv';

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================================
// TRANSLATION
// ============================================================

function formatTaskTitle(task) {
    const original = task.title || '';
    const vi = (window.taskTranslations && window.taskTranslations[original]) ? window.taskTranslations[original] : '';
    if (vi && vi !== original) {
        return `${original}<br><span style="color:#64748b; font-size:12px; display:inline-block; margin-top:2px;">/ ${vi}</span>`;
    }
    return original;
}

async function translateTitles(tasks) {
    if (!window.taskTranslations) window.taskTranslations = {};
    if (!window.db) return;
    
    try {
        const doc = await window.db.collection('settings').doc('taskTranslations').get();
        if (doc.exists) {
            window.taskTranslations = doc.data() || {};
        }
    } catch (e) {
        console.error("Failed to load translations from DB", e);
    }

    const toTranslate = [];
    tasks.forEach(t => {
        const title = t.title ? t.title.trim() : '';
        if (title && !window.taskTranslations[title]) {
            if (!toTranslate.includes(title)) {
                toTranslate.push(title);
            }
        }
    });

    if (toTranslate.length > 0) {
        const chunkSize = 50;
        let modified = false;
        
        for (let i = 0; i < toTranslate.length; i += chunkSize) {
            const chunk = toTranslate.slice(i, i + chunkSize);
            const text = encodeURIComponent(chunk.join('\n'));
            try {
                const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=' + text);
                const data = await res.json();
                let result = '';
                if(data && data[0]) {
                    data[0].forEach(item => result += item[0] || '');
                }
                const translatedLines = result.split('\n');
                chunk.forEach((original, idx) => {
                    if (translatedLines[idx]) {
                        window.taskTranslations[original] = translatedLines[idx].trim();
                        modified = true;
                    }
                });
            } catch (e) {
                console.error("Translation error", e);
            }
        }
        
        if (modified) {
            try {
                await window.db.collection('settings').doc('taskTranslations').set(window.taskTranslations);
            } catch(e) { console.error(e); }
        }
    }
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();

    // Load task meta from Firestore
    if (window.loadAllTaskMetaFromFirestore) {
        await window.loadAllTaskMetaFromFirestore();
    }

    // Load milestones from Firestore
    await loadMilestonesFromFirestore();

    // Fetch tasks from GitLab
    await fetchProjectTasks();

    // Initial render
    renderUnassignedTasks();

    // Hide loading
    const loader = document.getElementById('ms-loading');
    if (loader) loader.classList.add('hidden');

    // Translate in background
    translateTitles(msState.allTasks).then(() => {
        // Re-render to show translations
        renderUnassignedTasks();
        if(typeof renderDoneUnassignedTasks === 'function') renderDoneUnassignedTasks();
        if (msState.currentMilestone) {
            renderMsTaskTable();
        }
    });

    // --- Event Bindings ---
    document.getElementById('btn-create-ms').addEventListener('click', createMilestone);
    document.getElementById('btn-close-ms').addEventListener('click', () => closeMilestone(msState.currentMilestone));
    document.getElementById('btn-delete-ms').addEventListener('click', () => deleteMilestone(msState.currentMilestone));
    document.getElementById('btn-add-to-ms').addEventListener('click', addSelectedToMilestone);
    document.getElementById('btn-remove-from-ms')?.addEventListener('click', removeSelectedFromMilestone);
    
    const btnExport = document.getElementById('btn-export-excel');
    if (btnExport) btnExport.addEventListener('click', exportMilestoneToExcel);

    document.getElementById('ms-select').addEventListener('change', (e) => {
        selectMilestone(e.target.value);
    });

    document.getElementById('unassigned-search').addEventListener('input', () => {
        msState.selectedTaskIds.clear();
        document.getElementById('select-all-checkbox').checked = false;
        renderUnassignedTasks();
        updateAddButtonState();
    });

    document.getElementById('select-all-checkbox').addEventListener('change', toggleSelectAll);

    const selectAllDone = document.getElementById('done-unassigned-select-all');
    if (selectAllDone) selectAllDone.addEventListener('change', toggleDoneSelectAll);

    const btnAddDone = document.getElementById('btn-add-done-to-ms');
    if (btnAddDone) btnAddDone.addEventListener('click', addSelectedDoneToMilestone);

    const selectAllMs = document.getElementById('select-all-ms-checkbox');
    if (selectAllMs) selectAllMs.addEventListener('change', toggleSelectAllMs);

    console.log('Milestone page initialized successfully');
});
