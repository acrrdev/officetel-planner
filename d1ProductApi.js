// 운영용 상품 / 통계 API
// 브라우저 -> Cloudflare Worker -> D1
const d1ProductApi = {
    API_BASE_URL: 'https://acrrot123-api.acrrot123.workers.dev',
    SITE_CODE: 'officetel_furniture',

    async getProducts(category) {
        const params = new URLSearchParams({
            category,
            site: this.SITE_CODE
        });

        const response = await fetch(`${this.API_BASE_URL}/api/products?${params}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            let message = `D1 product API error: ${response.status}`;
            try {
                const errorBody = await response.json();
                if (errorBody?.error) message += ` - ${errorBody.error}`;
            } catch (_) {}
            throw new Error(message);
        }

        const data = await response.json();
        return Array.isArray(data) ? data : (data.products || []);
    },

    async recordVisit(isUnique) {
        return await this.postStats('/api/stats/visit', {
            is_unique: isUnique === true
        });
    },

    async recordProductClick(productId) {
        return await this.postStats('/api/stats/product-click', {
            product_id: Number(productId)
        });
    },

    async postStats(path, body) {
        const response = await fetch(`${this.API_BASE_URL}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(body),
            keepalive: true
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data?.error || `D1 stats API error: ${response.status}`);
        }

        return data;
    }
};
