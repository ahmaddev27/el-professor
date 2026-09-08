const API_URL = import.meta.env.VITE_API_URL || 'http://localhost/backend';

interface ApiResponse<T = any> {
  data?: T;
  error?: { message: string };
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        return { error: { message: data.error || 'Request failed' } };
      }

      return { data };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Network error',
        },
      };
    }
  }

  auth = {
    signInWithPassword: async (credentials: { email: string; password: string }) => {
      const response = await this.request('/auth.php?action=login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });

      if (response.error) {
        return { data: { user: null, session: null }, error: response.error };
      }

      return {
        data: {
          user: response.data.user,
          session: response.data.session,
        },
        error: null,
      };
    },

    signUp: async (credentials: { email: string; password: string; fullName?: string }) => {
      return await this.request('/auth.php?action=register', {
        method: 'POST',
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
          fullName: credentials.fullName,
        }),
      });
    },

    signOut: async () => {
      return await this.request('/auth.php?action=logout', {
        method: 'POST',
      });
    },

    getSession: async () => {
      const response = await this.request('/auth.php?action=session', {
        method: 'GET',
      });

      if (response.error) {
        return { data: { session: null }, error: response.error };
      }

      return {
        data: {
          session: response.data.session,
          user: response.data.user,
          profile: response.data.profile,
        },
        error: null,
      };
    },

    onAuthStateChange: (callback: (event: string, session: any) => void) => {
      return {
        data: { subscription: { unsubscribe: () => {} } },
      };
    },
  };

  from(table: string) {
    return new QueryBuilder(this.baseUrl, table);
  }
}

class QueryBuilder {
  private baseUrl: string;
  private table: string;
  private selectFields: string = '*';
  private filters: { field: string; operator: string; value: any }[] = [];
  private ordering: string = '';
  private limitValue?: number;

  constructor(baseUrl: string, table: string) {
    this.baseUrl = baseUrl;
    this.table = table;
  }

  select(fields: string = '*') {
    this.selectFields = fields;
    return this;
  }

  eq(field: string, value: any) {
    this.filters.push({ field, operator: 'eq', value });
    return this;
  }

  neq(field: string, value: any) {
    this.filters.push({ field, operator: 'neq', value });
    return this;
  }

  gte(field: string, value: any) {
    this.filters.push({ field, operator: 'gte', value });
    return this;
  }

  lte(field: string, value: any) {
    this.filters.push({ field, operator: 'lte', value });
    return this;
  }

  order(field: string, options?: { ascending?: boolean }) {
    const direction = options?.ascending === false ? 'desc' : 'asc';
    this.ordering = `${field}:${direction}`;
    return this;
  }

  limit(count: number) {
    this.limitValue = count;
    return this;
  }

  private buildQueryString() {
    const params = new URLSearchParams();

    this.filters.forEach((filter) => {
      params.append(`${filter.field}[${filter.operator}]`, filter.value);
    });

    if (this.ordering) {
      params.append('order', this.ordering);
    }

    if (this.limitValue) {
      params.append('limit', this.limitValue.toString());
    }

    return params.toString();
  }

  async maybeSingle() {
    const result = await this.execute();
    if (result.error) return result;

    const data = Array.isArray(result.data) ? result.data[0] || null : null;
    return { data, error: null };
  }

  async single() {
    const result = await this.maybeSingle();
    if (!result.data) {
      return { data: null, error: { message: 'No rows found' } };
    }
    return result;
  }

  private async execute() {
    try {
      const queryString = this.buildQueryString();
      const url = `${this.baseUrl}/api/${this.table}.php${queryString ? `?${queryString}` : ''}`;

      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (!response.ok) {
        return { data: null, error: { message: data.error || 'Request failed' } };
      }

      return { data, error: null };
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : 'Network error',
        },
      };
    }
  }

  async insert(record: any) {
    try {
      const url = `${this.baseUrl}/api/${this.table}.php`;

      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
      });

      const data = await response.json();

      if (!response.ok) {
        return { data: null, error: { message: data.error || 'Insert failed' } };
      }

      return { data, error: null };
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : 'Network error',
        },
      };
    }
  }

  async update(record: any) {
    try {
      if (!this.filters.find((f) => f.field === 'id')) {
        return { data: null, error: { message: 'ID is required for update' } };
      }

      const id = this.filters.find((f) => f.field === 'id')?.value;
      const url = `${this.baseUrl}/api/${this.table}.php?id=${id}`;

      const response = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
      });

      const data = await response.json();

      if (!response.ok) {
        return { data: null, error: { message: data.error || 'Update failed' } };
      }

      return { data, error: null };
    } catch (error) {
      return {
        data: null,
        error: {
          message: error instanceof Error ? error.message : 'Network error',
        },
      };
    }
  }

  async delete() {
    try {
      if (!this.filters.find((f) => f.field === 'id')) {
        return { error: { message: 'ID is required for delete' } };
      }

      const id = this.filters.find((f) => f.field === 'id')?.value;
      const url = `${this.baseUrl}/api/${this.table}.php?id=${id}`;

      const response = await fetch(url, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (!response.ok) {
        return { error: { message: data.error || 'Delete failed' } };
      }

      return { error: null };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Network error',
        },
      };
    }
  }
}

export const api = new ApiClient(API_URL);
export const isApiConfigured = true;
