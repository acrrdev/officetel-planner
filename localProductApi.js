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
    }
};
