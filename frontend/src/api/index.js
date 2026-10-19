import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// 帳號系統：自動帶 token・401 自動登出
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('auth_token');
  if (t) cfg.headers.Authorization = 'Bearer ' + t;
  return cfg;
});
api.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401 && !err.config?.url?.includes('/auth/login')) {
    localStorage.removeItem('auth_token');
    if (!window.location.search.includes('loggedout')) window.location.reload();
  }
  return Promise.reject(err);
});

export const login = (username, password) =>
  api.post('/auth/login', { username, password }, { timeout: 10000 }).then(r => r.data);

export const getMe = () =>
  api.get('/auth/me', { timeout: 10000 }).then(r => r.data);

export const getJockeys = (filters = {}) =>
  api.get('/jockeys', { params: filters }).then(r => r.data);

export const getJockeyFilters = () =>
  api.get('/jockeys/filters').then(r => r.data);

export const getTrainers = (filters = {}) =>
  api.get('/trainers', { params: filters }).then(r => r.data);

export const getTrainerFilters = () =>
  api.get('/trainers/filters').then(r => r.data);

export const getDrawSearch = (filters = {}) =>
  api.get('/draw/search', { params: filters }).then(r => r.data);

export const getDrawOptions = () =>
  api.get('/draw/options').then(r => r.data);

export const getNextRace = () =>
  api.get('/races/next').then(r => r.data);

export const getRacecard = (date) =>
  api.get('/races/racecard', { params: date ? { date } : {} }).then(r => r.data);

export const getAdvancedRacecard = (date) =>
  api.get('/races/advanced', { params: date ? { date } : {} }).then(r => r.data);

// 高級排位表：晨操紀錄批量抓取（賽前試閘 / 騎師親試）
export const updateAdvancedTrackwork = (date, raceNo = null) =>
  api.post('/advanced/trackwork', { date, race_no: raceNo }, { timeout: 15000 }).then(r => r.data);

export const getAdvancedTrackworkStatus = () =>
  api.get('/advanced/trackwork/status', { timeout: 10000 }).then(r => r.data);

// 高級排位表：分段時間回補（同程最快末段 / 最快末段用）
export const startSectionalBackfill = (date) =>
  api.post('/advanced/sectional-backfill', { date }, { timeout: 15000 }).then(r => r.data);

export const getSectionalBackfillStatus = () =>
  api.get('/advanced/sectional-backfill/status', { timeout: 10000 }).then(r => r.data);

// 高級排位表：手動更新排位體重
export const updateDeclaredWeight = (date, raceNo, horseNo, declaredWeight) =>
  api.patch('/races/advanced/weight',
    { date, race_no: raceNo, horse_no: horseNo, declared_weight: declaredWeight },
    { timeout: 15000 }).then(r => r.data);

export const getFixtures = () =>
  api.get('/races').then(r => r.data);

export const getAiAnalyze = (params = {}) =>
  api.get('/ai/analyze', { params, timeout: 120000 }).then(r => r.data);

export const getAiFactors = () =>
  api.get('/ai/factors').then(r => r.data);

// 步速分析（走位推算跑法 + 步速形勢）
export const getPaceAnalysis = (date) =>
  api.get('/races/pace', { params: date ? { date } : {}, timeout: 60000 }).then(r => r.data);

export const getAiR2 = (params = {}) =>
  api.get('/ai/r2', { params, timeout: 300000 }).then(r => r.data);

export const getAiFactorWeights = (params = {}) =>
  api.get('/ai/factor-weights', { params, timeout: 60000 }).then(r => r.data);

export const triggerScrape = (type, body = null) =>
  api.post(`/scrape/${type}`, body, { timeout: 5000 }).then(r => r.data);

export const getHorses = (q) =>
  api.get('/horses', { params: q ? { q } : {} }).then(r => r.data);

export const getHorse = (id) =>
  api.get(`/horses/${id}`).then(r => r.data);

export const scrapeHorse = (horseId) =>
  api.post(`/scrape/horse/${horseId}`).then(r => r.data);

export const scrapeCourseTime = () =>
  api.post('/scrape/coursetime').then(r => r.data);

export const getCourseTime = (params = {}) =>
  api.get('/coursetime', { params }).then(r => r.data);

export const getCourseRecords = (params = {}) =>
  api.get('/coursetime/records', { params }).then(r => r.data);

export const scrapeHorses = () =>
  api.post('/scrape/horses').then(r => r.data);

export default api;
