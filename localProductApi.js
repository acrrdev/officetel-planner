// 로컬 개발용 상품 API
// 브라우저 -> localhost:3000 -> SQLite(products.db)
const localProductApi = {
    API_BASE_URL: 'http://localhost:3000',
    SITE_CODE: 'officetel_furniture',

    async getProducts(category) {
        const params = new URLSearchParams({
            category,
            site: this.SITE_CODE
        });
        const response = await fetch(`${this.API_BASE_URL}/api/products?${params}`);

        if (!response.ok) {
            throw new Error(`Local product API error: ${response.status}`);
        }

        const data = await response.json();
        return Array.isArray(data) ? data : (data.products || []);
    },

    async recordVisit(isUnique) {
        return await this.postStats('/api/stats/visit', { is_unique: isUnique === true });
    },

    async recordProductClick(productId) {
        return await this.postStats('/api/stats/product-click', { product_id: Number(productId) });
    },

    async postStats(path, body) {
        const response = await fetch(`${this.API_BASE_URL}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `Local stats API error: ${response.status}`);
        return data;
    }
};
