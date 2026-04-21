let GITLAB_TOKEN = localStorage.getItem('gitlab_token_v2') || '';
if (!GITLAB_TOKEN || !GITLAB_TOKEN.startsWith('glpat-')) {
    const pass = prompt("Yêu cầu xác thực. Vui lòng nhập mật khẩu dự án:");
    if (pass) {
        const hex = "0005040d154f373b3f2c24393d2036202e06341a0d393c020d231d533e5d2a38041a2e08312a173f0811165e335339204b4557585a5d56524758445e0e00";
        let str = "";
        for(let i=0; i<hex.length; i+=2) {
            str += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ pass.charCodeAt((i/2) % pass.length));
        }
        if (str.startsWith('glpat-')) {
            GITLAB_TOKEN = str;
            localStorage.setItem('gitlab_token_v2', str);
        } else {
            alert("Mật khẩu sai. Dữ liệu sẽ không được tải!");
        }
    }
}
const GITLAB_BASE_URL = 'https://gitlab.com/api/v4';
const GROUP_IDS = ['4922129', '3590912', '58863801'];

const urlParams = new URLSearchParams(window.location.search);
const TARGET_USER = urlParams.get('user');

if (!TARGET_USER) {
    window.location.href = 'index.html';
}

const CREATED_AFTER = '2025-01-01T00:00:00Z';

// Initialize Lucide icons
lucide.createIcons();

const state = {
    tasks: [],
    customerTasks: [],
    devTasks: [],
    allIssues: [],
    allCustomerIssues: [],
    todayFilteredEvents: [],
    labelEventsEnriched: false,
    loading: false
};

// Utils
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

const isOverdue = (createdAt) => {
    const created = new Date(createdAt);
    const now = new Date();
    const diffDays = Math.ceil(Math.abs(now - created) / (1000 * 60 * 60 * 24));
    return diffDays > 5;
};

const getProjectName = (task) => {
    if (task.references && task.references.full) {
        const parts = task.references.full.split('#');
        if (parts.length > 0) {
            const pathParts = parts[0].split('/');
            return pathParts[pathParts.length - 1] || 'FinanceAccounting';
        }
    }
    return 'FinanceAccounting';
};

// LocalStorage Manager
const loadTaskMeta = (taskId) => {
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

const saveTaskMeta = (taskId, meta) => {
    if (window.taskMetaMap) window.taskMetaMap[taskId] = meta;
    localStorage.setItem(`taskMeta_${taskId}`, JSON.stringify(meta));
    if (window.db) {
        window.db.collection("taskMeta").doc(String(taskId)).set(meta).catch(e => {
            console.error("Error saving task meta to Firestore:", e);
        });
    }
};

const handleTaskMetaLogic = (task) => {
    const meta = loadTaskMeta(task.id);
    const labels = (task.labels || []).map(l => l.toLowerCase());
    
    const hasRevision = labels.some(l => l.includes('revision'));
    const hasReview = labels.some(l => l.includes('review'));

    if (hasRevision && !hasReview && meta.lastTriggeredLabel !== 'revision') {
        const historyEntry = {
            round: meta.currentRound,
            startDate: meta.startDate || '',
            endDate: meta.endDate || '',
            estimate: meta.estimate || '',
            timestamp: new Date().toISOString()
        };
        meta.history.push(historyEntry);

        meta.currentRound += 1;
        meta.startDate = '';
        meta.endDate = '';
        meta.estimate = '';
        meta.lastTriggeredLabel = 'revision';
        
        saveTaskMeta(task.id, meta);
    } else if (hasReview && meta.lastTriggeredLabel === 'revision') {
        meta.lastTriggeredLabel = 'review';
        saveTaskMeta(task.id, meta);
    }
    return meta;
};

// Update Input Field
window.updateInputField = (taskId, field, value) => {
    const meta = loadTaskMeta(taskId);
    meta[field] = value;
    saveTaskMeta(taskId, meta);
};

// Render Functions
const renderTaskList = async (taskArray, tbodyId, emptyStateId, showProjectColumn = true) => {
    const tbody = document.getElementById(tbodyId);
    const emptyState = document.getElementById(emptyStateId);
    
    tbody.innerHTML = '';
    
    if (taskArray.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    
    emptyState.classList.add('hidden');

    for (let index = 0; index < taskArray.length; index++) {
        const task = taskArray[index];
        const meta = handleTaskMetaLogic(task);
        const tr = document.createElement('tr');
        
        const isWarning = isOverdue(task.created_at);
        const warningHTML = isWarning ? `<span class="warning-badge"><i data-lucide="triangle-alert" class="icon-sm"></i> TASK QUÁ 5 NGÀY CẦN ƯU TIÊN</span>` : '';
        const assigneeNames = task.assignees?.map(a => a.name).join(', ') || 'Chưa gán';
        const labelsList = task.labels || [];
        const isRevision = labelsList.some(l => l.toLowerCase().includes('revision'));
        
        // Tags representation
        let tagsHTML = `<div class="tag tag-user"><i data-lucide="user" class="icon-sm"></i> Author: ${task.author.name}</div>`;
        tagsHTML += `<div class="tag tag-assignee"><i data-lucide="users" class="icon-sm"></i> Assignee: ${assigneeNames}</div>`;
        
        labelsList.forEach(l => {
            const lower = l.toLowerCase();
            if (lower.includes('bug')) tagsHTML += `<div class="tag tag-bug"><i data-lucide="bug" class="icon-sm"></i> ${l}</div>`;
            else if (lower.includes('review')) tagsHTML += `<div class="tag tag-review">${l}</div>`;
            else if (lower.includes('revision')) tagsHTML += `<div class="tag label-badge revision">${l}</div>`;
            else tagsHTML += `<div class="tag" style="background: #e2e8f0; color: #334155; border: 1px solid #cbd5e1;"><i data-lucide="tag" class="icon-sm"></i> ${l}</div>`;
        });

        // History UI
        let progressHTML = '';
        meta.history.forEach(h => {
            const roundHTML = (tbodyId === 'customer-task-table-body') ? '' : `<div class="round-badge">LẦN ${h.round}</div>`;
            const statusHTML = (tbodyId === 'customer-task-table-body') ? '' : `<div class="label-badge">HOÀN THÀNH</div>`;
            progressHTML += `
                <div class="test-progress-container history-block">
                    ${roundHTML}
                    ${statusHTML}
                    <div class="input-group-wrapper">
                        <div class="input-block">
                            <label>BẮT ĐẦU</label>
                            <input type="date" class="input-control" value="${h.startDate || ''}" readonly>
                        </div>
                        <div class="input-block">
                            <label>KẾT THÚC</label>
                            <input type="date" class="input-control" value="${h.endDate || ''}" readonly>
                        </div>
                        <div class="input-block">
                            <label>THỜI GIAN</label>
                            <input type="text" class="input-control time-input" value="${h.estimate || '0'}" readonly>
                        </div>
                    </div>
                </div>
            `;
        });

        const activeBadgeText = isRevision ? 'REVISION' : 'TO REVIEW';
        const activeBadgeClass = isRevision ? 'label-badge revision' : 'label-badge';
        const activeBadgeHTML = (tbodyId === 'dev-task-table-body' || tbodyId === 'customer-task-table-body') ? '' : `<div class="${activeBadgeClass}">${activeBadgeText}</div>`;
        const currentRoundHTML = (tbodyId === 'customer-task-table-body') ? '' : `<div class="round-badge">LẦN ${meta.currentRound}</div>`;

        // Current UI
        progressHTML += `
            <div class="test-progress-container">
                ${currentRoundHTML}
                ${activeBadgeHTML}
                <div class="input-group-wrapper">
                    <div class="input-block">
                        <label>BẮT ĐẦU</label>
                        <input type="date" class="input-control" value="${meta.startDate || ''}" onchange="updateInputField(${task.id}, 'startDate', this.value)">
                    </div>
                    <div class="input-block">
                        <label>KẾT THÚC</label>
                        <input type="date" class="input-control" value="${meta.endDate || ''}" onchange="updateInputField(${task.id}, 'endDate', this.value)">
                    </div>
                    <div class="input-block" style="flex:0">
                        <label>THỜI GIAN</label>
                        <input type="text" class="input-control time-input" value="${meta.estimate || ''}" onchange="updateInputField(${task.id}, 'estimate', this.value)">
                    </div>
                </div>
            </div>
        `;

        const projectColHTML = showProjectColumn 
            ? `<td><div class="project-badge">${getProjectName(task)}</div></td>` 
            : '';

        const devHTML = (tbodyId === 'customer-task-table-body' || tbodyId === 'dev-task-table-body') ? '' : `<div class="task-dev">Dev: ${assigneeNames}</div>`;

        tr.innerHTML = `
            <td class="cell-stt">${index + 1}</td>
            <td>
                <div class="task-header">
                    <a href="${task.web_url}" target="_blank" class="task-link">#${task.iid} <i data-lucide="external-link" class="icon-sm"></i></a>
                    <span class="task-date">Tạo: ${formatDateVN(task.created_at)}</span>
                    ${warningHTML}
                </div>
                <h3 class="task-title">${task.title}</h3>
                <div class="task-tags">${tagsHTML}</div>
                ${devHTML}
            </td>
            ${projectColHTML}
            <td>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    ${progressHTML}
                </div>
            </td>
        `;

        tbody.appendChild(tr);
    }
    
    lucide.createIcons();
};

// Fetch Data
const fetchIssues = async () => {
    const loadingEl = document.getElementById('loading-indicator');
    loadingEl.classList.remove('hidden');
    state.loading = true;
    let allIssues = [];

    try {
        for (const groupId of GROUP_IDS) {
            let page = 1;
            let hasNext = true;
            while (hasNext) {
                const url = `${GITLAB_BASE_URL}/groups/${groupId}/issues?created_after=${CREATED_AFTER}&per_page=100&page=${page}&state=opened`;
                
                try {
                    const res = await fetch(url, {
                        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
                    });
                    
                    if (!res.ok) break;

                    const data = await res.json();
                    if (Array.isArray(data) && data.length > 0) {
                        allIssues = [...allIssues, ...data];
                        if (data.length < 100) hasNext = false;
                        else page++;
                    } else {
                        hasNext = false;
                    }
                } catch(e) {
                    console.error("Lỗi CORS hoặc Network khi gọi GitLab API. Đang sử dụng dữ liệu mẫu (Mock).");
                    hasNext = false;
                }
            }
        }

        // Lưu bản đầy đủ trước khi filter
        state.allIssues = allIssues;

        // Lọc Dev tasks
        const devTasks = allIssues.filter(issue => {
            const isAuthor = issue.author?.username === TARGET_USER;
            if (!isAuthor) return false;

            const labels = (issue.labels || []).map(l => l.toLowerCase());
            return !labels.some(l => l.includes('review') || l.includes('revision') || l.includes('done'));
        });

        devTasks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        state.devTasks = devTasks;
        await renderTaskList(state.devTasks, 'dev-task-table-body', 'dev-empty-state');

        // Filter and enrich cho View/Revision tasks
        const enriched = await Promise.all(allIssues.map(async (issue) => {
            // Lọc label trước để giảm thiểu API calls
            if (!issue.labels || issue.labels.length === 0) return null;
            const labels = issue.labels.map(l => l.toLowerCase());
            if (!labels.some(l => l.includes('review') || l.includes('revision'))) return null;

            const isAuthor = issue.author?.username === TARGET_USER;
            const isAssignee = issue.assignees?.some(a => a.username === TARGET_USER);

            let notesData = [];

            // Chỉ fetch notes nếu chưa phải là author hoặc assignee
            if (!isAuthor && !isAssignee) {
                try {
                    const notesRes = await fetch(`${GITLAB_BASE_URL}/projects/${issue.project_id}/issues/${issue.iid}/notes?per_page=100`, {
                        headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
                    });
                    if (notesRes.ok) {
                        notesData = await notesRes.json();
                    }
                } catch (e) {
                    console.error(`Lỗi fetch notes cho issue ${issue.iid}:`, e);
                }
            }

            const isCommenter = notesData.some(n => n.author?.username === TARGET_USER);

            if (isAuthor || isAssignee || isCommenter) {
                return { ...issue };
            }

            return null;
        }));

        const finalTasks = enriched.filter(item => item !== null);

        // Mock data nếu fetch lỗi
        if (finalTasks.length === 0 && allIssues.length === 0) {
             console.log("No issues fetched, pushing mock issues for presentation");
             finalTasks.push({
                  id: 123456,
                  iid: 521,
                  web_url: 'https://gitlab.com/mock/project/-/issues/521',
                  created_at: '2026-04-06T00:00:00Z',
                  title: '[CM-FAen] The Counterparties catalog does not synchronize the deletion mark status when syncing from CM to FA.',
                  author: { name: 'Thị Thu Trang Trần' },
                  assignees: [{ name: 'Thị Thu Trang Trần' }],
                  labels: ['Bug', 'TO REVIEW'],
                  references: { full: 'company/FinanceAccounting#521' }
             });
             finalTasks.push({
                  id: 123457,
                  iid: 522,
                  web_url: 'https://gitlab.com/mock/project/-/issues/522',
                  created_at: '2026-03-01T00:00:00Z',
                  title: '[FA] Revision task logic needs update.',
                  author: { name: 'Thị Thu Trang Trần' },
                  assignees: [{ name: 'Thị Thu Trang Trần' }],
                  labels: ['Bug', 'Revision'],
                  references: { full: 'company/FinanceAccounting#522' }
             });
        }

        // Sort: review first
        finalTasks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        state.tasks = finalTasks;
        await renderTaskList(state.tasks, 'task-table-body', 'empty-state');
        if (window.updateDashboard) { updateDashboard(); }

    } catch (err) {
        console.error("General error details:", err);
    } finally {
        state.loading = false;
        loadingEl.classList.add('hidden');
    }
};

const fetchCustomerTasks = async () => {
    const customerProjectId = '44977878';
    let customerIssues = [];
    let page = 1;
    let hasNext = true;
    while (hasNext) {
        const url = `${GITLAB_BASE_URL}/projects/${customerProjectId}/issues?created_after=${CREATED_AFTER}&per_page=100&page=${page}&state=opened`;
        try {
            const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } });
            if (!res.ok) break;
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                customerIssues = [...customerIssues, ...data];
                if (data.length < 100) hasNext = false;
                else page++;
            } else {
                hasNext = false;
            }
        } catch (e) {
            console.error("Lỗi fetchCustomerTasks:", e);
            hasNext = false;
        }
    }

    // Lưu bản đầy đủ trước khi filter
    state.allCustomerIssues = customerIssues;

    const enriched = await Promise.all(customerIssues.map(async (issue) => {
        const labels = (issue.labels || []).map(l => l.toLowerCase());
        if (labels.includes('done')) return null;

        const isAuthor = issue.author?.username === TARGET_USER;
        const isAssignee = issue.assignees?.some(a => a.username === TARGET_USER);

        if (!isAuthor && !isAssignee) return null;

        let hasGitlabLink = false;
        try {
            const notesRes = await fetch(`${GITLAB_BASE_URL}/projects/${customerProjectId}/issues/${issue.iid}/notes?per_page=100`, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } });
            if (notesRes.ok) {
                const notesData = await notesRes.json();
                hasGitlabLink = notesData.some(n => {
                    const bodyStr = (n.body || '').toLowerCase();
                    return bodyStr.includes('gitlab.com');
                });
            }
        } catch (e) {
            console.error(`Lỗi fetch notes cho customer issue ${issue.iid}:`, e);
        }

        if (hasGitlabLink) return null;

        return { ...issue };
    }));

    const finalCustomerTasks = enriched.filter(item => item !== null);
    finalCustomerTasks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    state.customerTasks = finalCustomerTasks;
    await renderTaskList(state.customerTasks, 'customer-task-table-body', 'customer-empty-state', false);
    if (window.updateDashboard) { updateDashboard(); }
};

/* Dashboard Logic */
let targetUserId = null;

const fetchUserId = async () => {
    try {
        const res = await fetch(`${GITLAB_BASE_URL}/users?username=${TARGET_USER}`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        const users = await res.json();
        if (users && users.length > 0) {
            targetUserId = users[0].id;
            const nameEl = document.getElementById('dashboard-user-name');
            if (nameEl) {
                nameEl.textContent = `- ${users[0].name} (@${TARGET_USER})`;
            }
        }
    } catch (e) {
        console.error("Lỗi lấy user id", e);
    }
};

const renderEventsBoard = (events) => {
    const tbody = document.getElementById('board-events-body');
    const emptyState = document.getElementById('board-events-empty');
    if (!tbody || !emptyState) return;

    tbody.innerHTML = '';
    
    if (events.length === 0) {
        document.getElementById('count-events').innerText = '0';
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    const grouped = {};
    const orderlyKeys = [];

    events.forEach(ev => {
        let key = ev.target_iid;
        if (ev.target_type === 'Note' && ev.note && ev.note.noteable_iid) {
            key = ev.note.noteable_iid;
        }

        const isPush = ev.push_data || ev.target_type === 'Push';
        if (!key) {
            key = isPush ? `push_${ev.project_id || ev.id}` : `other_${ev.id}`;
        } else {
            key = `task_${key}_${ev.project_id || ''}`;
        }

        if (!grouped[key]) {
            grouped[key] = {
                events: [],
                time: ev.created_at, // The latest event time for this task
                targetIid: key.startsWith('task_') ? key.split('_')[1] : null,
                url: ev.web_url || '',
                issue_title: ev.issue_title || '',
                project_name: ev.project_name || ''
            };
            orderlyKeys.push(key);
        }
        grouped[key].events.push(ev);

        // Update url and title if they appear in later events
        if (!grouped[key].url && ev.web_url) grouped[key].url = ev.web_url;
        if (!grouped[key].issue_title && ev.issue_title) grouped[key].issue_title = ev.issue_title;
        if (!grouped[key].project_name && ev.project_name) grouped[key].project_name = ev.project_name;
    });

    document.getElementById('count-events').innerText = orderlyKeys.length;

    orderlyKeys.forEach((key, index) => {
        const group = grouped[key];
        const time = new Date(group.time).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        
        let idText = '';
        if (group.targetIid) {
            idText = `#${group.targetIid}`;
            if (group.url) {
                idText = `<a href="${group.url}" target="_blank" style="color:#2563eb; font-weight:700; text-decoration:none;">${idText}</a>`;
            } else {
                idText = `<span style="color:#2563eb; font-weight:700;">${idText}</span>`;
            }
        }

        const actionCounts = {};
        let combinedTitle = group.issue_title;

        group.events.forEach(ev => {
            let actionDisplay = (ev.action_name || '').toLowerCase();
            if (actionDisplay.includes('comment')) actionDisplay = 'COMMENT';
            else if (actionDisplay.includes('open') || actionDisplay.includes('create')) actionDisplay = 'CREATE';
            else if (actionDisplay.includes('assign')) actionDisplay = 'ASSIGN';
            else if (actionDisplay.includes('add')) actionDisplay = 'ADDED';
            else if (actionDisplay.includes('remove')) actionDisplay = 'REMOVED';
            else if (actionDisplay.includes('push')) actionDisplay = 'PUSHED';
            else if (actionDisplay.includes('update')) actionDisplay = 'UPDATED';
            else actionDisplay = actionDisplay.toUpperCase();
            
            actionCounts[actionDisplay] = (actionCounts[actionDisplay] || 0) + 1;

            if (!combinedTitle) {
                if (ev.push_data && ev.push_data.commit_title) {
                    combinedTitle = ev.push_data.commit_title;
                } else if (ev.target_title) {
                    combinedTitle = ev.target_title;
                }
            }
        });

        if (!combinedTitle) combinedTitle = 'Hoạt động hệ thống';

        let actionBadgesHtml = '<div style="display: flex; flex-wrap: wrap; gap: 4px;">';
        Object.keys(actionCounts).forEach(act => {
            const countStr = actionCounts[act] > 1 ? ` (${actionCounts[act]})` : '';
            actionBadgesHtml += `<div class="action-btn" style="margin:0;">${act}${countStr}</div>`;
        });
        actionBadgesHtml += '</div>';

        let projectSpan = group.project_name ? `<span style="font-size: 10px; background: #e0f2fe; color: #0369a1; font-weight: 700; padding: 2px 6px; border-radius: 4px; border: 1px solid #bae6fd; margin-left: 6px;">${group.project_name}</span>` : '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="col-stt" style="font-weight: 700; color: #10b981;">${index + 1}</td>
            <td style="max-width: 0; width: 100%;">
                <div style="margin-bottom: 4px; display: flex; align-items: center;">
                    ${idText ? `<span style="color:#2563eb; font-weight:700;">${idText}</span>` : ''}
                    ${projectSpan}
                </div>
                <div style="font-weight: 500; font-size: 13px; color: #1e293b; margin-bottom: 8px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; word-break: break-word;" title="${combinedTitle.replace(/"/g, '&quot;')}">${combinedTitle}</div>
                ${actionBadgesHtml}
            </td>
            <td class="col-time"><span class="event-time">${time}</span></td>
        `;
        tbody.appendChild(tr);
    });
};

const fetchTodayEvents = async () => {
    if (!targetUserId) await fetchUserId();
    if (!targetUserId) return;

    // Lấy mốc 0h của ngày hôm nay theo múi giờ local
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Truyền tham số 'after' là ngày hôm qua để API lấy dư vùng timezone, sau đó lọc thủ công
    const yesterday = new Date(todayStart);
    yesterday.setDate(yesterday.getDate() - 1);
    const afterParam = yesterday.toISOString().split('T')[0];

    try {
        const res = await fetch(`${GITLAB_BASE_URL}/users/${targetUserId}/events?after=${afterParam}&per_page=100`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        if (!res.ok) return;
        const events = await res.json();
        
        const validActions = ['comment', 'open', 'create', 'assign', 'add', 'added', 'remove', 'push', 'pushed', 'update', 'join'];
        
        const filtered = events.filter(e => {
            const evDate = new Date(e.created_at);
            // Chỉ lấy event >= 0h hôm nay
            if (evDate < todayStart) return false;

            const action = (e.action_name || '').toLowerCase();
            return validActions.some(v => action.includes(v));
        });

        state.todayFilteredEvents = filtered;

        const elInteractions = document.getElementById('stat-interactions');
        if (elInteractions) {
            elInteractions.innerText = state.todayFilteredEvents.length;
        }

        renderEventsBoard(state.todayFilteredEvents);
    } catch (e) {
        console.error("Lỗi fetch events", e);
    }
};

const renderOverdueBoard = (tasks) => {
    const tbody = document.getElementById('board-overdue-body');
    const emptyState = document.getElementById('board-overdue-empty');
    if (!tbody || !emptyState) return;

    document.getElementById('count-overdue').innerText = tasks.length;
    tbody.innerHTML = '';
    if (tasks.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    tasks.forEach((t, i) => {
        const meta = loadTaskMeta(t.id);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="col-stt" style="color:#f43f5e; font-weight:700;">${i + 1}</td>
            <td>
                <div style="margin-bottom: 4px;">
                    <a href="${t.web_url}" target="_blank" style="color:#2563eb; font-weight:700; text-decoration:none;">#${t.iid}</a>
                    <span style="font-size:10px; color:#64748b; margin-left:8px;">Tạo: ${formatDateVN(t.created_at)}</span>
                </div>
                <div style="font-weight: 500; font-size: 13px; color: #1e293b; margin-bottom: 4px; line-height: 1.4;">${t.title}</div>
            </td>
            <td class="col-date" style="color:#f43f5e; font-weight:700;">
                ${meta.endDate ? formatDateVN(meta.endDate) : ''}
            </td>
        `;
        tbody.appendChild(tr);
    });
};

const renderUnplannedBoard = (tasks) => {
    const tbody = document.getElementById('board-unplanned-body');
    const emptyState = document.getElementById('board-unplanned-empty');
    if (!tbody || !emptyState) return;

    document.getElementById('count-unplanned').innerText = tasks.length;
    tbody.innerHTML = '';
    if (tasks.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    tasks.forEach((t, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="col-stt" style="color:#64748b; font-weight:700;">${i + 1}</td>
            <td>
                <div style="margin-bottom: 4px;">
                    <a href="${t.web_url}" target="_blank" style="color:#2563eb; font-weight:700; text-decoration:none;">#${t.iid}</a>
                    <span style="font-size:10px; color:#64748b; margin-left:8px;">Tạo: ${formatDateVN(t.created_at)}</span>
                </div>
                <div style="font-weight: 500; font-size: 13px; color: #1e293b; margin-bottom: 4px; line-height: 1.4;">${t.title}</div>
            </td>
            <td class="col-plan">
                <div class="plan-inputs">
                    <div class="plan-input-row">
                        <span>BẮT ĐẦU</span>
                        <input type="date" class="input-dash-start" onkeydown="handlePlanEnter(event, ${t.id})">
                    </div>
                    <div class="plan-input-row">
                        <span>KẾT THÚC</span>
                        <input type="date" class="input-dash-end" onkeydown="handlePlanEnter(event, ${t.id})">
                    </div>
                    <div class="plan-input-row">
                        <span>THỜI GIAN</span>
                        <input type="text" placeholder="phút" class="input-dash-time" onkeydown="handlePlanEnter(event, ${t.id})">
                    </div>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
};

const enrichEventsWithLabels = async (allTasks) => {
    if (state.labelEventsEnriched) return;
    if (!targetUserId) return;
    state.labelEventsEnriched = true;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const tasksUpdatedToday = allTasks.filter(t => t.updated_at && new Date(t.updated_at) >= todayStart);

    let newCount = 0;
    for (const t of tasksUpdatedToday) {
        try {
            const res = await fetch(`${GITLAB_BASE_URL}/projects/${t.project_id}/issues/${t.iid}/resource_label_events`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
            });
            if (!res.ok) continue;
            const labelEvents = await res.json();
            
            labelEvents.forEach(ev => {
                if (ev.user?.id === targetUserId && new Date(ev.created_at) >= todayStart) {
                    const exists = state.todayFilteredEvents.some(existing => existing.id === `label_${ev.id}`);
                    if (!exists) {
                        state.todayFilteredEvents.push({
                            id: `label_${ev.id}`,
                            created_at: ev.created_at,
                            action_name: ev.action === 'add' ? 'added label' : 'removed label',
                            target_iid: t.iid,
                            target_type: 'Issue',
                            target_title: `Label "${ev.label?.name || ''}"`
                        });
                        newCount++;
                    }
                }
            });
        } catch (e) {
            console.error('Lỗi fetch label events:', e);
        }
    }

    let enrichedCount = 0;
    state.todayFilteredEvents.forEach(ev => {
        let iid = ev.target_iid;
        if (ev.target_type === 'Note' && ev.note && ev.note.noteable_iid) {
            iid = ev.note.noteable_iid;
        }
        if (iid && !ev.web_url) {
            const tk = allTasks.find(t => t.iid === iid && (!ev.project_id || t.project_id === ev.project_id));
            if (tk) {
                ev.web_url = tk.web_url;
                ev.issue_title = tk.title;
                ev.project_name = getProjectName(tk);
                enrichedCount++;
            }
        }
    });

    if (newCount > 0 || enrichedCount > 0) {
        state.todayFilteredEvents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const elInteractions = document.getElementById('stat-interactions');
        if (elInteractions) {
            elInteractions.innerText = state.todayFilteredEvents.length;
        }
        renderEventsBoard(state.todayFilteredEvents);
    }
};

window.updateDashboard = () => {
    const all = [];
    const pushMap = {};
    const pushUnique = (list) => {
        list.forEach(t => {
            if (!pushMap[t.id]) {
                pushMap[t.id] = true;
                all.push(t);
            }
        });
    }
    pushUnique(state.tasks);
    pushUnique(state.customerTasks);
    pushUnique(state.devTasks);

    // Truyền toàn bộ issue gốc để không bị sót task đã filter (ví dụ task đã có label DONE)
    const allKnownIssuesForLabels = [...(state.allIssues || []), ...(state.allCustomerIssues || [])];
    enrichEventsWithLabels(allKnownIssuesForLabels);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const overdueTasks = all.filter(t => {
        const meta = loadTaskMeta(t.id);
        const labels = (t.labels || []).map(l => l.toLowerCase());
        const isRevision = labels.some(l => l.includes('revision'));
        
        if (isRevision) return false;
        if (!meta.startDate && !meta.endDate) return false;

        if (meta.endDate) {
            const end = new Date(meta.endDate);
            end.setHours(0,0,0,0);
            return end < today;
        }
        return false;
    });

    const unplannedTasks = all.filter(t => {
        const meta = loadTaskMeta(t.id);
        const labels = (t.labels || []).map(l => l.toLowerCase());
        const isRevision = labels.some(l => l.includes('revision'));
        
        if (isRevision) return false;
        if (meta.startDate || meta.endDate) return false;

        const isAssignee = t.assignees?.some(a => a.username === TARGET_USER);
        return isAssignee;
    });

    renderOverdueBoard(overdueTasks);
    renderUnplannedBoard(unplannedTasks);
    renderPlanner();
};

window.handlePlanEnter = (e, taskId) => {
    if (e.key === 'Enter') {
        const tr = e.target.closest('tr');
        const start = tr.querySelector('.input-dash-start').value;
        const end = tr.querySelector('.input-dash-end').value;
        const time = tr.querySelector('.input-dash-time').value;
        
        if (start || end || time) {
            const meta = loadTaskMeta(taskId);
            if (start) meta.startDate = start;
            if (end) meta.endDate = end;
            if (time) meta.estimate = time;
            saveTaskMeta(taskId, meta);
            
            updateDashboard();
            renderTaskList(state.tasks, 'task-table-body', 'empty-state');
            renderTaskList(state.customerTasks, 'customer-task-table-body', 'customer-empty-state', false);
        }
    }
};

/* Planner and Stats Logic */
const parseEstimateToHours = (estStr) => {
    if (!estStr) return 0;
    const s = String(estStr).toLowerCase().replace(/ /g, '');
    let num = parseFloat(s);
    if (isNaN(num)) return 0;
    if (s.includes('h')) return num;
    if (s.includes('p') || s.includes('m')) return num / 60;
    if (num > 10) return num / 60;
    return num;
};

let plannerDate = new Date();
plannerDate.setHours(0,0,0,0);
let dayIdx = plannerDate.getDay(); 
let diffToMonday = plannerDate.getDate() - dayIdx + (dayIdx === 0 ? -6 : 1);
let plannerWeekStart = new Date(plannerDate.setDate(diffToMonday));
let selectedPlannerDate = new Date();
selectedPlannerDate.setHours(0,0,0,0);

const renderPlanner = () => {
    const allTasks = [...state.tasks, ...state.customerTasks];
    const uniqueTasks = new Map();
    allTasks.forEach(t => uniqueTasks.set(t.id, t));
    const finalAllTasks = Array.from(uniqueTasks.values());

    const daysArr = [];
    const weekEnd = new Date(plannerWeekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    
    const labelEl = document.getElementById('week-range-label');
    if (labelEl) labelEl.innerText = `${plannerWeekStart.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit', year:'numeric'})} - ${weekEnd.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit', year:'numeric'})}`;

    for (let i = 0; i < 7; i++) {
        const d = new Date(plannerWeekStart);
        d.setDate(d.getDate() + i);
        daysArr.push(d);
    }

    const labels = ["TH 2", "TH 3", "TH 4", "TH 5", "TH 6", "TH 7", "CN"];
    
    const barsContainer = document.getElementById('chart-bars');
    if (!barsContainer) return;
    barsContainer.innerHTML = '';
    
    let selectedDayHours = 0;
    let selectedDayTasks = [];

    daysArr.forEach((d, idx) => {
        let totalHours = 0;
        const dayTasks = [];

        finalAllTasks.forEach(t => {
            const meta = loadTaskMeta(t.id);
            if (!meta.startDate) return;
            const s = new Date(meta.startDate); s.setHours(0,0,0,0);
            const e = meta.endDate ? new Date(meta.endDate) : s; e.setHours(0,0,0,0);
            
            if (d >= s && d <= e) {
                const diffDays = Math.ceil((e - s) / (1000*60*60*24)) + 1;
                const hrs = parseEstimateToHours(meta.estimate);
                const dailyHrs = hrs / diffDays;
                totalHours += dailyHrs;
                
                dayTasks.push({ task: t, meta, dailyHrs });
            }
        });

        const maxDaily = 8;
        const heightPct = Math.min((totalHours / maxDaily) * 100, 100);
        const isActive = d.getTime() === selectedPlannerDate.getTime();
        
        if (isActive) {
            selectedDayHours = totalHours;
            selectedDayTasks = dayTasks;
        }

        const dateStr = `${d.getDate()}/${d.getMonth()+1}`;
        const lbl = labels[idx];

        const wrapper = document.createElement('div');
        wrapper.className = `chart-bar-wrapper ${isActive ? 'active' : ''}`;
        wrapper.onclick = () => {
            selectedPlannerDate = d;
            renderPlanner();
        };

        wrapper.innerHTML = `
            <div class="chart-bar-bg">
                <div class="chart-bar-fill" style="height: ${heightPct}%"></div>
            </div>
            <div class="chart-day-label">
                ${lbl}<br>${dateStr}
            </div>
        `;
        barsContainer.appendChild(wrapper);
    });

    const elSelectedDayHours = document.getElementById('selected-day-hours');
    if (elSelectedDayHours) elSelectedDayHours.innerText = `${selectedDayHours.toFixed(1)}h`;
    
    const elSelectedDayLabel = document.getElementById('selected-day-label');
    if (elSelectedDayLabel) elSelectedDayLabel.innerText = `TASK NGÀY ${selectedPlannerDate.toLocaleDateString('vi-VN', {day:'2-digit', month:'2-digit', year:'numeric'})}`;
    
    const elSelectedDayCount = document.getElementById('selected-day-count');
    if (elSelectedDayCount) elSelectedDayCount.innerText = `${selectedDayTasks.length} task`;

    const taskListEl = document.getElementById('selected-day-tasks');
    if(taskListEl) {
        taskListEl.innerHTML = '';
        
        if (selectedDayTasks.length === 0) {
            taskListEl.innerHTML = `<div class="empty-state" style="padding: 20px; color:#94a3b8; font-style:italic;"><p>Không có task phân bổ trong ngày này</p></div>`;
        } else {
            selectedDayTasks.forEach(dt => {
                const projName = getProjectName(dt.task);
                const item = document.createElement('div');
                item.className = 'planner-task-item';
                item.innerHTML = `
                    <div class="planner-task-icon">
                        <i data-lucide="briefcase"></i>
                    </div>
                    <div class="planner-task-content">
                        <div class="planner-task-meta">
                            <a href="${dt.task.web_url}" target="_blank">#${dt.task.iid}</a> <i data-lucide="corner-up-right" style="width:10px;height:10px;"></i> ${projName}
                        </div>
                        <div class="planner-task-title">${dt.task.title}</div>
                    </div>
                    <div class="planner-task-time">
                        <div class="planner-task-time-val">${dt.dailyHrs.toFixed(1)}h</div>
                        <div class="planner-task-time-lbl">PHÂN BỔ</div>
                    </div>
                `;
                taskListEl.appendChild(item);
            });
        }
    }
    
    updateTopStats(finalAllTasks);
    lucide.createIcons();
};

const updateTopStats = (finalAllTasks) => {
    const totalTasks = finalAllTasks.length;
    let reviewCount = 0;
    let revisionCount = 0;

    finalAllTasks.forEach(t => {
        const labels = (t.labels || []).map(l => l.toLowerCase());
        const hasRevision = labels.some(l => l.includes('revision'));
        const hasReview = labels.some(l => l.includes('review'));
        
        if (hasRevision) revisionCount++;
        else if (hasReview) reviewCount++;
    });

    const elTotal = document.getElementById('stat-total-tasks');
    if (elTotal) elTotal.innerText = totalTasks;
    const elReview = document.getElementById('stat-review-tasks');
    if (elReview) elReview.innerText = reviewCount;
    const elRevision = document.getElementById('stat-revision-tasks');
    if (elRevision) elRevision.innerText = revisionCount;
}

window.changePlannerWeek = (offset) => {
    plannerWeekStart.setDate(plannerWeekStart.getDate() + (offset * 7));
    renderPlanner();
};

document.addEventListener('DOMContentLoaded', async () => {
    // Initial static population in case fetch takes time
    const nameEl = document.getElementById('dashboard-user-name');
    if (nameEl) {
        nameEl.textContent = `- User: @${TARGET_USER}`;
    }
    if (window.loadAllTaskMetaFromFirestore) {
        await window.loadAllTaskMetaFromFirestore();
    }
    fetchTodayEvents();
    fetchCustomerTasks();
    fetchIssues();
});
